import type { Store } from "../store";
import type { LLMConfig } from "../config";
import { StaleContentFenceError } from "../repositories/content-fence-repository";
import { awaitWithAbort, withAbortDeadline } from "../abort";
import { DEFAULT_OLLAMA_BASE_URL } from "../config";
import { ollamaEmbedding } from "../llm-client";

export const DEFAULT_EMBEDDING_DEADLINE_MS = 120_000;

export class EmbeddingDeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`Embedding request could not complete within the ${deadlineMs}ms deadline`);
    this.name = "EmbeddingDeadlineExceededError";
  }
}

export interface EmbeddingRequestOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

// Cosine similarity between two vectors
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Embeddings from different models can have different dimensions. Comparing
  // only their shared prefix can produce a convincing but meaningless score.
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Which providers expose an embeddings endpoint. Others must gracefully
// degrade to keyword search.
export function embeddingSupported(provider: string): boolean {
  return provider === "gemini" || provider === "azure-openai" || provider === "openai" || provider === "ollama";
}

/** Identity of the vector space actually used by getEmbedding(). */
export function embeddingModelIdentity(config: Pick<LLMConfig, "provider" | "endpoint" | "model">): string | null {
  switch (config.provider) {
    case "gemini":
      return "gemini:gemini-embedding-001";
    case "openai":
      return "openai:text-embedding-3-small";
    case "azure-openai":
      return `azure-openai:${config.endpoint.trim().replace(/\/+$/, "").toLowerCase()}:text-embedding-3-small`;
    case "ollama":
      // Ollama's embedding vector space depends on the chosen model, so it is
      // part of the identity (a model switch must invalidate stored vectors).
      return `ollama:${(config.endpoint.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "").toLowerCase()}:${config.model.trim()}`;
    default:
      return null;
  }
}

// Get embedding — auto-detect provider
export async function getEmbedding(
  text: string,
  config: LLMConfig,
  options: EmbeddingRequestOptions = {},
): Promise<Float32Array> {
  const input = text.slice(0, 8000);
  const deadlineMs = options.deadlineMs ?? DEFAULT_EMBEDDING_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || !Number.isInteger(deadlineMs) || deadlineMs < 1) {
    throw new RangeError("Embedding deadlineMs must be a positive finite integer");
  }
  const fetchFn = options.fetch ?? fetch;
  const timeoutError = new EmbeddingDeadlineExceededError(deadlineMs);
  const deadline = withAbortDeadline(deadlineMs, timeoutError, options.signal);

  try {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    let operation: Promise<Float32Array>;
    if (config.provider === "gemini") {
      operation = geminiEmbedding(input, config, fetchFn, deadline.signal);
    } else if (config.provider === "azure-openai") {
      operation = azureEmbedding(input, config, fetchFn, deadline.signal);
    } else if (config.provider === "openai") {
      operation = openaiEmbedding(input, config, fetchFn, deadline.signal);
    } else if (config.provider === "ollama") {
      operation = ollamaEmbedding(input, config, fetchFn, deadline.signal);
    } else {
      throw new Error(`Embedding not supported for provider: ${config.provider}`);
    }

    return await awaitWithAbort(operation, deadline.signal);
  } finally {
    deadline.cleanup();
  }
}

// Gemini Embedding API (free)
async function geminiEmbedding(
  text: string,
  config: LLMConfig,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<Float32Array> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent`;
  const resp = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.api_key },
    signal,
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] }
    })
  });
  if (!resp.ok) throw new Error(`Gemini embedding error (${resp.status})`);
  const data = await resp.json() as { embedding: { values: number[] } };
  return new Float32Array(data.embedding.values);
}

// Azure OpenAI Embedding
async function azureEmbedding(
  text: string,
  config: LLMConfig,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<Float32Array> {
  const url = `${config.endpoint}/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-06-01`;
  const resp = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": config.api_key },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
    signal,
  });
  if (!resp.ok) throw new Error(`Azure embedding error (${resp.status})`);
  const data = await resp.json() as { data: Array<{ embedding: number[] }> };
  return new Float32Array(data.data[0].embedding);
}

// OpenAI Embedding
async function openaiEmbedding(
  text: string,
  config: LLMConfig,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<Float32Array> {
  const resp = await fetchFn("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.api_key}` },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
    signal,
  });
  if (!resp.ok) throw new Error(`OpenAI embedding error (${resp.status})`);
  const data = await resp.json() as { data: Array<{ embedding: number[] }> };
  return new Float32Array(data.data[0].embedding);
}

// Generate embeddings for all pages that don't have one
export async function generateMissingEmbeddings(store: Store, config: LLMConfig, onProgress?: (msg: string) => void): Promise<number> {
  const modelIdentity = embeddingModelIdentity(config);
  if (!modelIdentity) return 0;
  const pages = store.getPagesWithoutEmbeddings(modelIdentity);
  if (!pages.length) return 0;

  onProgress?.(`⏳ ${pages.length}개 페이지 임베딩 생성 중...`);
  let count = 0;

  for (const page of pages) {
    try {
      const text = `${page.title}\n\n${page.content.slice(0, 4000)}`;
      const embedding = await getEmbedding(text, config);
      store.saveEmbedding(page.id, embedding, modelIdentity);
      count++;
      if (count % 10 === 0) onProgress?.(`  ${count}/${pages.length} 완료`);
    } catch (e) {
      if (e instanceof StaleContentFenceError) throw e;
      // Skip failed pages silently
      onProgress?.(`  ⚠ ${page.title} 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  onProgress?.(`✅ ${count}개 임베딩 생성 완료`);
  return count;
}

// Semantic search: find pages similar to query text
export async function semanticSearch(
  query: string,
  store: Store,
  config: LLMConfig,
  limit: number = 5
): Promise<Array<{slug: string; title: string; pageType: string; origin: string; similarity: number}>> {
  const modelIdentity = embeddingModelIdentity(config);
  if (!modelIdentity) return [];
  const allEmbeddings = store.getAllEmbeddings(modelIdentity);
  if (!allEmbeddings.length) return [];

  // Get query embedding
  const queryEmbedding = await getEmbedding(query, config);

  // Calculate similarities
  const results = allEmbeddings.map(page => ({
    slug: page.slug,
    title: page.title,
    pageType: page.pageType,
    origin: page.origin,
    similarity: cosineSimilarity(queryEmbedding, page.embedding)
  }));

  // Sort by similarity descending, return top N
  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .filter(r => r.similarity > 0.3); // Minimum threshold
}
