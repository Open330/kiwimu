import { createHash } from "crypto";
import { join } from "path";
import { Store } from "../store";
import { type LLMConfig, type Persona, type WikiSchema } from "../config";
import { LLMClient, type UsageStats } from "../llm-client";
import { estimateIngest, type IngestEstimate } from "../pipeline/cost-estimator";
import {
  cleanupIngestStaging,
  createIngestGenerationFingerprint,
  ingestFigurePrefix,
  openIngestStaging,
  prepareIngestFigureStaging,
  publishStagedFigures,
} from "./ingest-staging";
import type { IngestSourceDraft, Source } from "../store";
import { throwIfAborted } from "../abort";

export interface IngestResult {
  sourceCount: number;
  conceptCount: number;
  linkCount: number;
  usage: UsageStats & { estimatedCostUsd: number | null };
  /** Skipped because the source content was unchanged since the last ingest. */
  unchanged?: boolean;
  /** Aborted by the cost-estimate confirmation hook. */
  cancelled?: boolean;
  /** Figure extraction result (PDF only). */
  figures?: { figureCount: number; captionedCount: number };
}

export interface IngestOptions {
  /** Re-ingest even if the content hash matches the previous run. */
  force?: boolean;
  /**
   * Called with a pre-ingest token/cost estimate BEFORE any LLM calls.
   * Return false to abort the ingest (no cost incurred).
   */
  onCostEstimate?: (est: IngestEstimate) => boolean | Promise<boolean>;
  /** Extract figures from PDFs (default true). */
  extractFigures?: boolean;
  /** Cooperatively cancels network, model, parser and subprocess work. */
  signal?: AbortSignal;
  /** Render and publish a complete candidate site with the final generation. */
  publishGeneration?: (generation: IngestGenerationPublication) => Source | Promise<Source>;
}

export interface IngestGenerationPublication {
  stagingStore: Store;
  stagingSourceId: number;
  draft: IngestSourceDraft;
  contentHash: string;
  /** Private directory containing this generation's not-yet-live figures. */
  stagedFigureDirectory?: string;
  publishFiles?: () => void;
}

async function publishGeneration(
  liveStore: Store,
  generation: IngestGenerationPublication,
  publisher: IngestOptions["publishGeneration"],
): Promise<Source> {
  if (publisher) return publisher(generation);
  return liveStore.publishIngestGeneration(
    generation.stagingStore,
    generation.stagingSourceId,
    generation.draft,
    generation.contentHash,
    generation.publishFiles,
  );
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const ZERO_USAGE = { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };

/**
 * Incremental gate: if the source already exists, its stored hash matches the
 * freshly-extracted text, it already has pages, and --force was not passed,
 * skip re-processing entirely. Returns true when the caller should skip.
 */
function shouldSkipUnchanged(
  store: Store,
  uri: string,
  contentHash: string,
  opts: IngestOptions | undefined
): boolean {
  if (opts?.force) return false;
  const existing = store.getSource(uri);
  if (!existing) return false;
  const prevHash = store.getSourceHash(uri);
  return prevHash === contentHash && store.countPagesBySource(existing.id) > 0;
}

/**
 * Decide whether an interrupted ingest can resume for this exact input.
 * Checkpoints from another content generation (including legacy unbound rows)
 * are discarded together with their partial source-owned output.
 */
export function prepareIngestAttempt(store: Store, sourceId: number, contentHash: string): boolean {
  const hasCheckpoints = store.hasCheckpoints(sourceId);
  const canResume = hasCheckpoints && store.checkpointsMatchInput(sourceId, contentHash);
  if (!canResume) {
    store.resetIngestGeneration(sourceId);
  }
  return canResume;
}

function makeClient(llmConfig: LLMConfig, onProgress?: (status: string) => void, signal?: AbortSignal): LLMClient {
  const client = new LLMClient(llmConfig, { signal });
  client.resetUsageStats();
  client.onRetry = (attempt, max, delayMs) => {
    const delaySec = Math.round(delayMs / 1000);
    onProgress?.(`⏳ Rate limit — 재시도 ${attempt}/${max}, ${delaySec}초 대기...`);
    console.log(`\x1b[33m⏳ Rate limit — retry ${attempt}/${max}, waiting ${delaySec}s...\x1b[0m`);
  };
  return client;
}

export async function ingestUrl(
  root: string,
  store: Store,
  url: string,
  llmConfig: LLMConfig,
  persona: Persona | null,
  onProgress?: (status: string) => void,
  schema?: WikiSchema,
  opts?: IngestOptions
): Promise<IngestResult> {
  const client = makeClient(llmConfig, onProgress, opts?.signal);

  const { fetchPage } = await import("../ingest/web");
  const { llmChunkDocument, htmlToRawText } = await import("../pipeline/llm-chunker");

  onProgress?.("⏳ URL 가져오는 중...");
  throwIfAborted(opts?.signal);
  const { title, html } = await fetchPage(url, { signal: opts?.signal });
  throwIfAborted(opts?.signal);
  const rawText = await htmlToRawText(html);

  if (!rawText || rawText.trim().length < 50) {
    throw new Error("추출된 텍스트가 너무 짧습니다. 파일 내용을 확인해주세요.");
  }

  const contentHash = hashText(rawText);

  // ── Incremental: skip if unchanged since last ingest ──
  if (shouldSkipUnchanged(store, url, contentHash, opts)) {
    onProgress?.("변경 없음 — 재인제스트 건너뜀 (--force로 강제)");
    return { sourceCount: 0, conceptCount: 0, linkCount: 0, usage: { ...ZERO_USAGE }, unchanged: true };
  }

  // ── Cost preview / confirmation before spending LLM calls ──
  if (opts?.onCostEstimate) {
    const est = estimateIngest(rawText, llmConfig.provider, llmConfig.model);
    const proceed = await opts.onCostEstimate(est);
    if (!proceed) {
      onProgress?.("사용자가 취소함");
      return { sourceCount: 0, conceptCount: 0, linkCount: 0, usage: { ...ZERO_USAGE }, cancelled: true };
    }
  }

  const draft: IngestSourceDraft = { uri: url, type: "web", title, rawContent: html };
  const generationFingerprint = createIngestGenerationFingerprint(llmConfig, persona, schema, {
    sourceType: draft.type,
    title: draft.title,
    extractFigures: false,
  });
  const staging = openIngestStaging(root, store, draft, contentHash, generationFingerprint);
  let source: Source;
  let sourceCount: number;
  let conceptCount: number;
  let published = false;
  try {
    const isResume = prepareIngestAttempt(staging.store, staging.source.id, staging.checkpointHash);
    onProgress?.(isResume ? "⏳ LLM 분석 재개..." : "⏳ LLM 분석 시작...");
    ({ sourceCount, conceptCount } = await llmChunkDocument(
      rawText,
      title,
      staging.source.id,
      staging.store,
      0,
      persona,
      client,
      onProgress,
      schema,
      false,
      staging.checkpointHash,
    ));
    throwIfAborted(opts?.signal);
    source = await publishGeneration(store, {
      stagingStore: staging.store,
      stagingSourceId: staging.source.id,
      draft,
      contentHash,
    }, opts?.publishGeneration);
    published = true;
  } finally {
    staging.store.close();
    if (published) {
      try {
        cleanupIngestStaging(staging);
      } catch (error) {
        onProgress?.(`⚠ 완료된 staging 정리 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const u = client.getUsageStats();
  const estimatedCostUsd = client.getEstimatedCost();
  // Legacy usage rows store numeric totals. Unknown custom-model prices are
  // excluded from that USD aggregate while token usage remains fully recorded.
  tryRecordIngestTelemetry("usage", () => {
    store.addUsageLog(source.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, estimatedCostUsd ?? 0);
  });
  tryRecordIngestTelemetry("activity", () => {
    store.addActivityLog('ingest', `Ingested ${title}`, 'source', source.id, { url, sourceCount, conceptCount });
  });

  return {
    sourceCount,
    conceptCount,
    linkCount: 0,
    usage: { ...u, estimatedCostUsd },
  };
}

export async function ingestFile(
  root: string,
  store: Store,
  filePath: string,
  originalName: string,
  llmConfig: LLMConfig,
  persona: Persona | null,
  onProgress?: (status: string) => void,
  schema?: WikiSchema,
  opts?: IngestOptions
): Promise<IngestResult> {
  const client = makeClient(llmConfig, onProgress, opts?.signal);

  const { llmChunkDocument } = await import("../pipeline/llm-chunker");

  const ext = originalName.split(".").pop()?.toLowerCase() || "";

  let title: string;
  let text: string;
  throwIfAborted(opts?.signal);

  switch (ext) {
    case "pdf": {
      const { extractTextFromPdf } = await import("../ingest/pdf");
      onProgress?.("⏳ PDF 텍스트 추출 중...");
      ({ title, text } = await extractTextFromPdf(filePath, opts?.signal));
      break;
    }
    case "docx": {
      const { extractTextFromDocx } = await import("../ingest/docx");
      onProgress?.("⏳ DOCX 텍스트 추출 중...");
      ({ title, text } = await extractTextFromDocx(filePath, opts?.signal));
      break;
    }
    case "pptx": {
      const { extractTextFromPptx } = await import("../ingest/pptx");
      onProgress?.("⏳ PPTX 텍스트 추출 중...");
      ({ title, text } = await extractTextFromPptx(filePath, opts?.signal));
      break;
    }
    case "md": {
      const { extractTextFromMarkdown } = await import("../ingest/markdown");
      onProgress?.("⏳ MD 텍스트 추출 중...");
      const result = extractTextFromMarkdown(filePath, opts?.signal);
      title = result.title;
      text = result.text;
      break;
    }
    default: {
      const { extractWithTextutil } = await import("../ingest/legacy");
      onProgress?.(`⏳ ${ext.toUpperCase()} 텍스트 추출 중...`);
      ({ title, text } = await extractWithTextutil(filePath, undefined, opts?.signal));
      break;
    }
  }
  throwIfAborted(opts?.signal);

  if (!text || text.trim().length < 50) {
    throw new Error("추출된 텍스트가 너무 짧습니다. 파일 내용을 확인해주세요.");
  }

  const contentHash = hashText(text);

  // ── Incremental: skip if unchanged since last ingest ──
  if (shouldSkipUnchanged(store, filePath, contentHash, opts)) {
    onProgress?.("변경 없음 — 재인제스트 건너뜀 (--force로 강제)");
    return { sourceCount: 0, conceptCount: 0, linkCount: 0, usage: { ...ZERO_USAGE }, unchanged: true };
  }

  // ── Cost preview / confirmation before spending LLM calls ──
  if (opts?.onCostEstimate) {
    const est = estimateIngest(text, llmConfig.provider, llmConfig.model);
    const proceed = await opts.onCostEstimate(est);
    if (!proceed) {
      onProgress?.("사용자가 취소함");
      return { sourceCount: 0, conceptCount: 0, linkCount: 0, usage: { ...ZERO_USAGE }, cancelled: true };
    }
  }

  // The immutable storage path is the source identity; retain the user-facing
  // filename separately so management/provenance views do not have to infer it
  // from the UUID directory.
  const draft: IngestSourceDraft = {
    uri: filePath,
    type: ext,
    title,
    rawContent: `(file: ${originalName})`,
  };
  const generationFingerprint = createIngestGenerationFingerprint(llmConfig, persona, schema, {
    sourceType: draft.type,
    title: draft.title,
    extractFigures: ext === "pdf" && opts?.extractFigures !== false,
  });
  const figureModule = ext === "pdf" && opts?.extractFigures !== false
    ? await import("../pipeline/figures")
    : null;
  const liveSource = store.getSource(filePath);
  const preservedFigureState = liveSource
    ? figureModule?.captureFigureState(store, liveSource.id)
    : undefined;
  const staging = openIngestStaging(root, store, draft, contentHash, generationFingerprint);
  let source: Source;
  let sourceCount: number;
  let conceptCount: number;
  let figures: { figureCount: number; captionedCount: number } | undefined;
  let stagedFigureDirectory: string | null = null;
  let published = false;
  try {
    const isResume = prepareIngestAttempt(staging.store, staging.source.id, staging.checkpointHash);
    onProgress?.(isResume ? "⏳ LLM 분석 재개..." : "⏳ LLM 분석 시작...");
    ({ sourceCount, conceptCount } = await llmChunkDocument(
      text,
      title,
      staging.source.id,
      staging.store,
      0,
      persona,
      client,
      onProgress,
      schema,
      false,
      staging.checkpointHash,
    ));
    throwIfAborted(opts?.signal);

    // ── Figure extraction (PDF only, staged with this generation) ──
    if (ext === "pdf" && opts?.extractFigures !== false) {
      try {
        stagedFigureDirectory = prepareIngestFigureStaging(staging);
        figures = await figureModule!.runFigureStage({
          store: staging.store,
          client,
          sourceId: staging.source.id,
          ext,
          filePath,
          uploadsFiguresDir: stagedFigureDirectory,
          onProgress,
          preservedState: preservedFigureState,
          filePrefix: ingestFigurePrefix(staging, contentHash),
          signal: opts?.signal,
        });
      } catch (e) {
        figureModule!.restoreFigureState(staging.store, staging.source.id, preservedFigureState);
        throwIfAborted(opts?.signal);
        if (e instanceof figureModule!.PdfFigureExtractionLimitError) throw e;
        onProgress?.(`⚠ 그림 추출 건너뜀: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    throwIfAborted(opts?.signal);
    source = await publishGeneration(store, {
      stagingStore: staging.store,
      stagingSourceId: staging.source.id,
      draft,
      contentHash,
      stagedFigureDirectory: stagedFigureDirectory ?? undefined,
      publishFiles: stagedFigureDirectory
        ? () => publishStagedFigures(stagedFigureDirectory!, join(root, "figures"))
        : undefined,
    }, opts?.publishGeneration);
    published = true;
  } finally {
    staging.store.close();
    if (published) {
      try {
        cleanupIngestStaging(staging);
      } catch (error) {
        onProgress?.(`⚠ 완료된 staging 정리 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const u = client.getUsageStats();
  const estimatedCostUsd = client.getEstimatedCost();
  tryRecordIngestTelemetry("usage", () => {
    store.addUsageLog(source.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, estimatedCostUsd ?? 0);
  });
  tryRecordIngestTelemetry("activity", () => {
    store.addActivityLog('ingest', `Ingested ${originalName}`, 'source', source.id, {
      filePath,
      originalName,
      sourceCount,
      conceptCount,
    });
  });

  return {
    sourceCount,
    conceptCount,
    linkCount: 0,
    usage: { ...u, estimatedCostUsd },
    figures,
  };
}

function tryRecordIngestTelemetry(kind: "usage" | "activity", record: () => void): void {
  try {
    record();
  } catch {
    // Content and its complete static site are already committed. Do not turn
    // successful publication into a failed job, and do not log source details.
    console.warn(`[kiwimu] Failed to record ingest ${kind} telemetry`);
  }
}
