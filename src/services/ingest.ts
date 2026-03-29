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

  const { fetchPage } = await import("../ingest/web");
  const { llmChunkDocument, htmlToRawText } = await import("../pipeline/llm-chunker");

  onProgress?.("⏳ URL 가져오는 중...");
  const { title, html } = await fetchPage(url);

  const source = store.addSource(url, "web", title, html);
  const rawText = await htmlToRawText(html);

  if (!rawText || rawText.trim().length < 50) {
    throw new Error("추출된 텍스트가 너무 짧습니다. 파일 내용을 확인해주세요.");
  }

  onProgress?.("⏳ LLM 분석 시작...");
  const { sourceCount, conceptCount } = await llmChunkDocument(rawText, title, source.id, store, 0, persona, client);

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

  const { llmChunkDocument } = await import("../pipeline/llm-chunker");

  const ext = originalName.split(".").pop()?.toLowerCase() || "";

  let title: string;
  let text: string;

  if (ext === "pdf") {
    const { extractTextFromPdf } = await import("../ingest/pdf");
    onProgress?.("⏳ PDF 텍스트 추출 중...");
    ({ title, text } = await extractTextFromPdf(filePath));
  } else if (ext === "docx") {
    const { extractTextFromDocx } = await import("../ingest/docx");
    onProgress?.("⏳ DOCX 텍스트 추출 중...");
    ({ title, text } = await extractTextFromDocx(filePath));
  } else if (ext === "pptx") {
    const { extractTextFromPptx } = await import("../ingest/pptx");
    onProgress?.("⏳ PPTX 텍스트 추출 중...");
    ({ title, text } = await extractTextFromPptx(filePath));
  } else {
    const { extractWithTextutil } = await import("../ingest/legacy");
    onProgress?.(`⏳ ${ext.toUpperCase()} 텍스트 추출 중...`);
    ({ title, text } = await extractWithTextutil(filePath));
  }

  if (!text || text.trim().length < 50) {
    throw new Error("추출된 텍스트가 너무 짧습니다. 파일 내용을 확인해주세요.");
  }

  const source = store.addSource(filePath, ext, title, "(file)");
  store.deletePagesBySource(source.id);

  onProgress?.("⏳ LLM 분석 시작...");
  const { sourceCount, conceptCount } = await llmChunkDocument(text, title, source.id, store, 0, persona, client);

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
