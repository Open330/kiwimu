import { createHash } from "crypto";
import type { Store, ChunkEmbeddingRow } from "../store";
import type { LLMConfig } from "../config";
import { StaleContentFenceError } from "../repositories/content-fence-repository";
import { cosineSimilarity, embeddingModelIdentity, embeddingSupported, getEmbedding } from "./embedding";
import { throwIfAborted } from "../abort";

// A function that turns text into an embedding vector. Injected in tests so
// there are never live embedding API calls.
export type EmbedFn = (text: string) => Promise<Float32Array>;

// Minimal LLM interface (LLMClient satisfies this). Injected in tests.
export interface ChatLike {
  chatComplete(system: string, userMessage: string, maxTokens?: number): Promise<string>;
}

export interface RetrievedChunk {
  chunkId: number;
  pageId: number;
  chunkIndex: number;
  slug: string;
  title: string;
  content: string;
  similarity: number;
}

export interface AskResult {
  answer: string;
  citations: Array<{ n: number; slug: string; title: string; snippet: string }>;
  method: "semantic" | "keyword";
  generated: boolean; // true if an LLM produced the answer, false if we returned raw passages
}

const DEFAULT_CHUNK_CHARS = 1200;
const DEFAULT_CHUNK_OVERLAP = 150;

/**
 * Split page content into overlapping chunks on paragraph/sentence boundaries.
 * Pure + deterministic — unit tested directly.
 */
export function splitIntoChunks(
  text: string,
  maxChars: number = DEFAULT_CHUNK_CHARS,
  overlap: number = DEFAULT_CHUNK_OVERLAP,
): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  // Split into paragraphs first, then pack into chunks up to maxChars.
  const paragraphs = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    // A single oversized paragraph: hard-split it.
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars - overlap) {
        chunks.push(para.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if (current.length + para.length + 2 > maxChars) {
      // carry a little overlap from the tail of the previous chunk
      const tail = current.slice(-overlap);
      flush();
      current = (tail ? tail + "\n\n" : "") + para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  flush();
  return chunks.filter(c => c.length > 0);
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Rough token estimate (~4 chars/token) — used for budget capping only. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Pure ranking: given a query vector and candidate chunks, return the top-k by
 * cosine similarity above a minimum threshold. No I/O — unit tested directly.
 */
export function rankChunks(
  queryEmbedding: Float32Array,
  chunks: ChunkEmbeddingRow[],
  k: number = 6,
  minSimilarity: number = 0.2,
): RetrievedChunk[] {
  return chunks
    .map(c => ({
      chunkId: c.chunkId,
      pageId: c.pageId,
      chunkIndex: c.chunkIndex,
      slug: c.slug,
      title: c.title,
      content: c.content,
      similarity: cosineSimilarity(queryEmbedding, c.embedding),
    }))
    .filter(r => r.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

/**
 * Incrementally (re)build the chunk vector index.
 * - Only re-chunks pages whose content hash changed (or that are new).
 * - Only embeds chunks that lack an embedding.
 * Returns counts. `embedFn` is injectable for tests.
 */
export async function indexWiki(
  store: Store,
  config: LLMConfig,
  opts: { onProgress?: (msg: string) => void; embedFn?: EmbedFn; model?: string; signal?: AbortSignal } = {},
): Promise<{ pagesChunked: number; chunksEmbedded: number; skipped: number }> {
  const onProgress = opts.onProgress;
  const model = opts.model ?? embeddingModelIdentity(config) ?? `custom:${config.provider}:${config.model}`;
  const embedFn: EmbedFn = opts.embedFn ?? ((text: string) => getEmbedding(text, config, { signal: opts.signal }));

  if (!opts.embedFn && (!embeddingSupported(config.provider) || !config.api_key || config.provider === "demo")) {
    onProgress?.("⚠ 임베딩 미지원 provider — RAG 인덱싱을 건너뜁니다 (키워드 검색으로 대체됨)");
    return { pagesChunked: 0, chunksEmbedded: 0, skipped: 0 };
  }

  const pages = store.listPages();
  let pagesChunked = 0;
  let skipped = 0;

  for (const page of pages) {
    throwIfAborted(opts.signal);
    const text = `${page.title}\n\n${page.content}`;
    const hash = hashContent(text);
    if (store.getChunkContentHash(page.id) === hash) {
      skipped++;
      continue; // unchanged — keep existing chunks + embeddings
    }
    const chunks = splitIntoChunks(page.content);
    // Prefix the title to each chunk to keep it self-descriptive for retrieval.
    const withTitle = chunks.map(c => `# ${page.title}\n\n${c}`);
    store.replaceChunks(page.id, withTitle.length ? withTitle : [text], hash);
    pagesChunked++;
  }

  store.deleteOrphanChunks();

  // Embed any chunk missing an embedding (new or re-chunked).
  const pending = store.getChunksWithoutEmbedding(model);
  if (pending.length) onProgress?.(`⏳ ${pending.length}개 청크 임베딩 생성 중...`);
  let chunksEmbedded = 0;
  for (const chunk of pending) {
    throwIfAborted(opts.signal);
    try {
      const emb = await embedFn(chunk.content.slice(0, 8000));
      store.saveChunkEmbedding(chunk.id, emb, model);
      chunksEmbedded++;
      if (chunksEmbedded % 20 === 0) onProgress?.(`  ${chunksEmbedded}/${pending.length} 완료`);
    } catch (e) {
      throwIfAborted(opts.signal);
      if (e instanceof StaleContentFenceError) throw e;
      onProgress?.(`  ⚠ 청크 임베딩 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  onProgress?.(`✅ RAG 인덱스: ${pagesChunked}개 페이지 재청킹, ${chunksEmbedded}개 임베딩, ${skipped}개 변경없음`);
  return { pagesChunked, chunksEmbedded, skipped };
}

/**
 * Semantic retrieval of relevant chunks for a query. Returns [] if there are no
 * embeddings (caller should fall back to keyword search). `embedFn` injectable.
 */
export async function retrieveChunks(
  store: Store,
  query: string,
  config: LLMConfig,
  k: number = 6,
  embedFn?: EmbedFn,
): Promise<RetrievedChunk[]> {
  const model = embeddingModelIdentity(config);
  if (!model) return [];
  const all = store.getAllChunkEmbeddings(model);
  if (!all.length) return [];
  const fn: EmbedFn = embedFn ?? ((text: string) => getEmbedding(text, config));
  const queryEmbedding = await fn(query);
  return rankChunks(queryEmbedding, all, k);
}

/** Keyword-based retrieval fallback using the store's FTS/LIKE search. */
export function keywordRetrieve(store: Store, query: string, k: number = 6): RetrievedChunk[] {
  const pages = store.searchPages(query, k);
  return pages.map((p, i) => {
    const full = store.getPage(p.slug);
    return {
      chunkId: -1,
      pageId: full?.id ?? -1,
      chunkIndex: i,
      slug: p.slug,
      title: p.title,
      content: full ? `# ${full.title}\n\n${full.content.slice(0, DEFAULT_CHUNK_CHARS)}` : p.preview,
      similarity: 0,
    };
  });
}

function buildContext(chunks: RetrievedChunk[], maxTokens: number): { context: string; used: RetrievedChunk[] } {
  const used: RetrievedChunk[] = [];
  const parts: string[] = [];
  let tokens = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const block = `[${i + 1}] (${c.title})\n${c.content}`;
    const t = estimateTokens(block);
    if (tokens + t > maxTokens && used.length) break;
    tokens += t;
    parts.push(block);
    used.push(c);
  }
  return { context: parts.join("\n\n---\n\n"), used };
}

/**
 * ask-the-wiki: retrieve relevant chunks → inject as context → LLM answers with
 * citations. Degrades to keyword retrieval if embeddings are unavailable, and to
 * returning raw passages if no LLM is configured.
 */
export async function askWiki(
  store: Store,
  question: string,
  config: LLMConfig,
  llm: ChatLike | null,
  opts: { k?: number; embedFn?: EmbedFn; maxContextTokens?: number } = {},
): Promise<AskResult> {
  const k = opts.k ?? 6;
  const maxContextTokens = opts.maxContextTokens ?? 3000;

  let method: "semantic" | "keyword" = "semantic";
  let chunks = await retrieveChunks(store, question, config, k, opts.embedFn);
  if (!chunks.length) {
    method = "keyword";
    chunks = keywordRetrieve(store, question, k);
  }

  const { context, used } = buildContext(chunks, maxContextTokens);
  const citations = used.map((c, i) => ({
    n: i + 1,
    slug: c.slug,
    title: c.title,
    snippet: c.content.replace(/^#\s.*\n+/, "").slice(0, 200),
  }));

  if (!used.length) {
    return {
      answer: "위키에서 관련 내용을 찾지 못했습니다. 먼저 문서를 추가해 주세요.",
      citations: [],
      method,
      generated: false,
    };
  }

  // No usable LLM → return the retrieved passages directly (still useful).
  if (!llm) {
    return {
      answer: "관련 문서를 찾았습니다. 아래 출처를 확인하세요.",
      citations,
      method,
      generated: false,
    };
  }

  const system =
    "You are a helpful assistant answering questions about a personal study wiki. " +
    "Answer ONLY using the provided context passages. " +
    "Cite the passages you use inline with bracketed numbers like [1], [2] that match the passage numbers. " +
    "If the context does not contain the answer, say you don't have enough information. " +
    "Answer in the same language as the question (Korean if the question is Korean).";

  const userMessage =
    `Context passages:\n\n${context}\n\n---\n\nQuestion: ${question}\n\n` +
    `Answer with inline [n] citations referencing the passages above.`;

  const answer = await llm.chatComplete(system, userMessage, 1500);
  return { answer: answer.trim(), citations, method, generated: true };
}
