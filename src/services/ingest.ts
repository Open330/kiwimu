import { createHash } from "crypto";
import { join } from "path";
import { existsSync, cpSync } from "fs";
import { Store } from "../store";
import { type LLMConfig, type Persona, type WikiSchema } from "../config";
import { LLMClient, type UsageStats } from "../llm-client";
import { estimateIngest, type IngestEstimate } from "../pipeline/cost-estimator";

export interface IngestResult {
  sourceCount: number;
  conceptCount: number;
  linkCount: number;
  usage: UsageStats & { estimatedCostUsd: number };
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

/** Copy persisted figures into the built site's static dir so they survive rebuilds. */
function mirrorFiguresToSite(root: string): void {
  try {
    const figuresDir = join(root, "figures");
    const siteStatic = join(root, "_site", "static");
    if (existsSync(figuresDir) && existsSync(siteStatic)) {
      cpSync(figuresDir, join(siteStatic, "figures"), { recursive: true });
    }
  } catch {
    // best-effort mirror for serve mode; the build step re-copies regardless
  }
}

function makeClient(llmConfig: LLMConfig, onProgress?: (status: string) => void): LLMClient {
  const client = new LLMClient(llmConfig);
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
  const client = makeClient(llmConfig, onProgress);

  const { fetchPage } = await import("../ingest/web");
  const { llmChunkDocument, htmlToRawText } = await import("../pipeline/llm-chunker");

  onProgress?.("⏳ URL 가져오는 중...");
  const { title, html } = await fetchPage(url);
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
    const est = estimateIngest(rawText, llmConfig.provider);
    const proceed = await opts.onCostEstimate(est);
    if (!proceed) {
      onProgress?.("사용자가 취소함");
      return { sourceCount: 0, conceptCount: 0, linkCount: 0, usage: { ...ZERO_USAGE }, cancelled: true };
    }
  }

  const source = store.addSource(url, "web", title, html);

  // Only delete existing pages if NOT resuming (no checkpoints = fresh ingest)
  if (!store.hasCheckpoints(source.id)) {
    store.deletePagesBySource(source.id);
  }

  const isResume = store.hasCheckpoints(source.id);
  onProgress?.(isResume ? "⏳ LLM 분석 재개..." : "⏳ LLM 분석 시작...");
  const { sourceCount, conceptCount } = await llmChunkDocument(rawText, title, source.id, store, 0, persona, client, onProgress, schema);

  // Pipeline completed successfully — clear checkpoints and record hash for incremental skip
  store.clearCheckpoints(source.id);
  store.setSourceHash(source.id, contentHash);

  const u = client.getUsageStats();
  const estimatedCostUsd = client.getEstimatedCost();
  store.addUsageLog(source.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, estimatedCostUsd);

  store.addActivityLog('ingest', `Ingested ${title}`, 'source', source.id, { url, sourceCount, conceptCount });

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
  const client = makeClient(llmConfig, onProgress);

  const { llmChunkDocument } = await import("../pipeline/llm-chunker");

  const ext = originalName.split(".").pop()?.toLowerCase() || "";

  let title: string;
  let text: string;

  switch (ext) {
    case "pdf": {
      const { extractTextFromPdf } = await import("../ingest/pdf");
      onProgress?.("⏳ PDF 텍스트 추출 중...");
      ({ title, text } = await extractTextFromPdf(filePath));
      break;
    }
    case "docx": {
      const { extractTextFromDocx } = await import("../ingest/docx");
      onProgress?.("⏳ DOCX 텍스트 추출 중...");
      ({ title, text } = await extractTextFromDocx(filePath));
      break;
    }
    case "pptx": {
      const { extractTextFromPptx } = await import("../ingest/pptx");
      onProgress?.("⏳ PPTX 텍스트 추출 중...");
      ({ title, text } = await extractTextFromPptx(filePath));
      break;
    }
    case "md": {
      const { extractTextFromMarkdown } = await import("../ingest/markdown");
      onProgress?.("⏳ MD 텍스트 추출 중...");
      const result = extractTextFromMarkdown(filePath);
      title = result.title;
      text = result.text;
      break;
    }
    default: {
      const { extractWithTextutil } = await import("../ingest/legacy");
      onProgress?.(`⏳ ${ext.toUpperCase()} 텍스트 추출 중...`);
      ({ title, text } = await extractWithTextutil(filePath));
      break;
    }
  }

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
    const est = estimateIngest(text, llmConfig.provider);
    const proceed = await opts.onCostEstimate(est);
    if (!proceed) {
      onProgress?.("사용자가 취소함");
      return { sourceCount: 0, conceptCount: 0, linkCount: 0, usage: { ...ZERO_USAGE }, cancelled: true };
    }
  }

  const source = store.addSource(filePath, ext, title, "(file)");

  // Only delete existing pages if NOT resuming (no checkpoints = fresh ingest)
  if (!store.hasCheckpoints(source.id)) {
    store.deletePagesBySource(source.id);
  }

  const isResume = store.hasCheckpoints(source.id);
  onProgress?.(isResume ? "⏳ LLM 분석 재개..." : "⏳ LLM 분석 시작...");
  const { sourceCount, conceptCount } = await llmChunkDocument(text, title, source.id, store, 0, persona, client, onProgress, schema);

  store.clearCheckpoints(source.id);

  // ── Figure extraction (PDF only, runs in incremental path too) ──
  let figures: { figureCount: number; captionedCount: number } | undefined;
  if (ext === "pdf" && opts?.extractFigures !== false) {
    try {
      const { runFigureStage } = await import("../pipeline/figures");
      figures = await runFigureStage({
        store,
        client,
        sourceId: source.id,
        ext,
        filePath,
        uploadsFiguresDir: join(root, "figures"),
        onProgress,
      });
      mirrorFiguresToSite(root);
    } catch (e) {
      onProgress?.(`⚠ 그림 추출 건너뜀: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  store.setSourceHash(source.id, contentHash);

  const u = client.getUsageStats();
  const estimatedCostUsd = client.getEstimatedCost();
  store.addUsageLog(source.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, estimatedCostUsd);

  store.addActivityLog('ingest', `Ingested ${originalName}`, 'source', source.id, { filePath, sourceCount, conceptCount });

  return {
    sourceCount,
    conceptCount,
    linkCount: 0,
    usage: { ...u, estimatedCostUsd },
    figures,
  };
}
