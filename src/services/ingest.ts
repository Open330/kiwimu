import { Store } from "../store";
import { type LLMConfig, type Persona } from "../config";
import { LLMClient, type UsageStats } from "../llm-client";

export interface IngestResult {
  sourceCount: number;
  conceptCount: number;
  linkCount: number;
  usage: UsageStats & { estimatedCostUsd: number };
}

export async function ingestUrl(
  root: string,
  store: Store,
  url: string,
  llmConfig: LLMConfig,
  persona: Persona | null,
  onProgress?: (status: string) => void
): Promise<IngestResult> {
  const client = new LLMClient(llmConfig);
  client.resetUsageStats();
  client.onRetry = (attempt, max, delayMs) => {
    const delaySec = Math.round(delayMs / 1000);
    onProgress?.(`⏳ Rate limit — 재시도 ${attempt}/${max}, ${delaySec}초 대기...`);
    console.log(`\x1b[33m⏳ Rate limit — retry ${attempt}/${max}, waiting ${delaySec}s...\x1b[0m`);
  };

  const { fetchPage } = await import("../ingest/web");
  const { llmChunkDocument, htmlToRawText } = await import("../pipeline/llm-chunker");

  onProgress?.("⏳ URL 가져오는 중...");
  const { title, html } = await fetchPage(url);

  const source = store.addSource(url, "web", title, html);
  const rawText = await htmlToRawText(html);

  if (!rawText || rawText.trim().length < 50) {
    throw new Error("추출된 텍스트가 너무 짧습니다. 파일 내용을 확인해주세요.");
  }

  // Only delete existing pages if NOT resuming (no checkpoints = fresh ingest)
  if (!store.hasCheckpoints(source.id)) {
    store.deletePagesBySource(source.id);
  }

  const isResume = store.hasCheckpoints(source.id);
  onProgress?.(isResume ? "⏳ LLM 분석 재개..." : "⏳ LLM 분석 시작...");
  const { sourceCount, conceptCount } = await llmChunkDocument(rawText, title, source.id, store, 0, persona, client, onProgress);

  // Pipeline completed successfully — clear checkpoints for clean future re-ingests
  store.clearCheckpoints(source.id);

  const u = client.getUsageStats();
  const estimatedCostUsd = client.getEstimatedCost();
  store.addUsageLog(source.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, estimatedCostUsd);

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
  onProgress?: (status: string) => void
): Promise<IngestResult> {
  const client = new LLMClient(llmConfig);
  client.resetUsageStats();
  client.onRetry = (attempt, max, delayMs) => {
    const delaySec = Math.round(delayMs / 1000);
    onProgress?.(`⏳ Rate limit — 재시도 ${attempt}/${max}, ${delaySec}초 대기...`);
    console.log(`\x1b[33m⏳ Rate limit — retry ${attempt}/${max}, waiting ${delaySec}s...\x1b[0m`);
  };

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

  const source = store.addSource(filePath, ext, title, "(file)");

  // Only delete existing pages if NOT resuming (no checkpoints = fresh ingest)
  if (!store.hasCheckpoints(source.id)) {
    store.deletePagesBySource(source.id);
  }

  const isResume = store.hasCheckpoints(source.id);
  onProgress?.(isResume ? "⏳ LLM 분석 재개..." : "⏳ LLM 분석 시작...");
  const { sourceCount, conceptCount } = await llmChunkDocument(text, title, source.id, store, 0, persona, client, onProgress);

  // Pipeline completed successfully — clear checkpoints for clean future re-ingests
  store.clearCheckpoints(source.id);

  const u = client.getUsageStats();
  const estimatedCostUsd = client.getEstimatedCost();
  store.addUsageLog(source.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, estimatedCostUsd);

  return {
    sourceCount,
    conceptCount,
    linkCount: 0,
    usage: { ...u, estimatedCostUsd },
  };
}
