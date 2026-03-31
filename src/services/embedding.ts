import type { Store } from "../store";
import type { LLMConfig } from "../config";

// Cosine similarity between two vectors
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Get embedding — auto-detect provider
async function getEmbedding(text: string, config: LLMConfig): Promise<Float32Array> {
  const input = text.slice(0, 8000);

  if (config.provider === "gemini") {
    return await geminiEmbedding(input, config);
  } else if (config.provider === "azure-openai") {
    return await azureEmbedding(input, config);
  } else if (config.provider === "openai") {
    return await openaiEmbedding(input, config);
  }
  throw new Error(`Embedding not supported for provider: ${config.provider}`);
}

// Gemini Embedding API (free)
async function geminiEmbedding(text: string, config: LLMConfig): Promise<Float32Array> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.api_key },
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
async function azureEmbedding(text: string, config: LLMConfig): Promise<Float32Array> {
  const url = `${config.endpoint}/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-06-01`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": config.api_key },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" })
  });
  if (!resp.ok) throw new Error(`Azure embedding error (${resp.status})`);
  const data = await resp.json() as { data: Array<{ embedding: number[] }> };
  return new Float32Array(data.data[0].embedding);
}

// OpenAI Embedding
async function openaiEmbedding(text: string, config: LLMConfig): Promise<Float32Array> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.api_key}` },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" })
  });
  if (!resp.ok) throw new Error(`OpenAI embedding error (${resp.status})`);
  const data = await resp.json() as { data: Array<{ embedding: number[] }> };
  return new Float32Array(data.data[0].embedding);
}

// Generate embeddings for all pages that don't have one
export async function generateMissingEmbeddings(store: Store, config: LLMConfig, onProgress?: (msg: string) => void): Promise<number> {
  const pages = store.getPagesWithoutEmbeddings();
  if (!pages.length) return 0;

  onProgress?.(`⏳ ${pages.length}개 페이지 임베딩 생성 중...`);
  let count = 0;

  for (const page of pages) {
    try {
      const text = `${page.title}\n\n${page.content.slice(0, 4000)}`;
      const embedding = await getEmbedding(text, config);
      store.saveEmbedding(page.id, embedding, "text-embedding-3-small");
      count++;
      if (count % 10 === 0) onProgress?.(`  ${count}/${pages.length} 완료`);
    } catch (e) {
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
  const allEmbeddings = store.getAllEmbeddings();
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
