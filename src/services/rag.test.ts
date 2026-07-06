import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Store } from "../store";
import type { ChunkEmbeddingRow } from "../store";
import {
  splitIntoChunks,
  hashContent,
  rankChunks,
  indexWiki,
  retrieveChunks,
  keywordRetrieve,
  askWiki,
  type EmbedFn,
  type ChatLike,
} from "./rag";
import type { LLMConfig } from "../config";

const cfg: LLMConfig = { provider: "openai", model: "x", api_key: "test-key", endpoint: "" };

// Deterministic fake embedder: maps a fixed vocabulary to unit-ish vectors so
// cosine similarity is predictable. NO live API calls.
const VOCAB = ["cat", "dog", "quantum", "physics", "wiki", "learning"];
const fakeEmbed: EmbedFn = async (text: string) => {
  const lower = text.toLowerCase();
  const v = new Float32Array(VOCAB.length);
  VOCAB.forEach((w, i) => { v[i] = (lower.match(new RegExp(w, "g")) || []).length + 0.01; });
  return v;
};

function makeChunk(id: number, slug: string, title: string, content: string, emb: number[]): ChunkEmbeddingRow {
  return { chunkId: id, pageId: id, chunkIndex: 0, slug, title, content, pageType: "concept", embedding: new Float32Array(emb) };
}

describe("splitIntoChunks", () => {
  test("returns single chunk for short text", () => {
    expect(splitIntoChunks("hello world")).toEqual(["hello world"]);
  });

  test("returns empty for blank", () => {
    expect(splitIntoChunks("   ")).toEqual([]);
  });

  test("splits long text into multiple chunks under maxChars", () => {
    const para = "A".repeat(500);
    const text = [para, para, para, para].join("\n\n");
    const chunks = splitIntoChunks(text, 600, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(600 + 50);
  });

  test("hard-splits an oversized single paragraph", () => {
    const chunks = splitIntoChunks("B".repeat(2000), 500, 50);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("hashContent", () => {
  test("stable + sensitive to change", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });
});

describe("rankChunks", () => {
  test("ranks by cosine similarity and respects k", () => {
    const chunks = [
      makeChunk(1, "a", "A", "cat", [5, 0, 0, 0, 0, 0]),
      makeChunk(2, "b", "B", "dog", [0, 5, 0, 0, 0, 0]),
      makeChunk(3, "c", "C", "quantum", [0, 0, 5, 0, 0, 0]),
    ];
    const q = new Float32Array([5, 0.1, 0, 0, 0, 0]); // closest to chunk 1
    const ranked = rankChunks(q, chunks, 2, 0);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].slug).toBe("a");
    expect(ranked[0].similarity).toBeGreaterThan(ranked[1].similarity);
  });

  test("filters below minSimilarity", () => {
    const chunks = [makeChunk(1, "a", "A", "cat", [0, 1, 0, 0, 0, 0])];
    const q = new Float32Array([1, 0, 0, 0, 0, 0]); // orthogonal → sim 0
    expect(rankChunks(q, chunks, 5, 0.5)).toHaveLength(0);
  });
});

describe("indexWiki (incremental, mocked embeddings)", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); store.initSchema(); });
  afterEach(() => store.close());

  test("chunks + embeds pages, then skips unchanged on re-run", async () => {
    store.addPage("cat-page", "Cat", "cat ".repeat(400), undefined, undefined, "concept", 0);
    store.addPage("dog-page", "Dog", "dog ".repeat(400), undefined, undefined, "concept", 0);

    const r1 = await indexWiki(store, cfg, { embedFn: fakeEmbed });
    expect(r1.pagesChunked).toBe(2);
    expect(r1.chunksEmbedded).toBeGreaterThan(0);
    expect(store.countChunkEmbeddings()).toBe(store.countChunks());

    // Re-run without changes → everything skipped, no new embeddings.
    const r2 = await indexWiki(store, cfg, { embedFn: fakeEmbed });
    expect(r2.pagesChunked).toBe(0);
    expect(r2.chunksEmbedded).toBe(0);
    expect(r2.skipped).toBe(2);
  });

  test("re-chunks only a changed page", async () => {
    store.addPage("cat-page", "Cat", "cat cat", undefined, undefined, "concept", 0);
    store.addPage("dog-page", "Dog", "dog dog", undefined, undefined, "concept", 0);
    await indexWiki(store, cfg, { embedFn: fakeEmbed });

    store.updatePageContentBySlug("cat-page", "cat cat cat physics");
    const r = await indexWiki(store, cfg, { embedFn: fakeEmbed });
    expect(r.pagesChunked).toBe(1);
    expect(r.skipped).toBe(1);
  });

  test("degrades (no-op) for unsupported provider without embedFn", async () => {
    store.addPage("p", "P", "content", undefined, undefined, "concept", 0);
    const r = await indexWiki(store, { provider: "anthropic", model: "m", api_key: "k", endpoint: "" });
    expect(r.chunksEmbedded).toBe(0);
    expect(store.countChunks()).toBe(0);
  });
});

describe("retrieveChunks + askWiki (mocked)", () => {
  let store: Store;
  beforeEach(async () => {
    store = new Store(":memory:");
    store.initSchema();
    store.addPage("quantum", "Quantum Physics", "quantum physics quantum physics", undefined, undefined, "concept", 0);
    store.addPage("cats", "Cats", "cat cat cat dog", undefined, undefined, "concept", 0);
    await indexWiki(store, cfg, { embedFn: fakeEmbed });
  });
  afterEach(() => store.close());

  test("retrieveChunks returns most relevant page first", async () => {
    const results = await retrieveChunks(store, "quantum physics", cfg, 5, fakeEmbed);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe("quantum");
  });

  test("askWiki injects context and returns generated answer with citations", async () => {
    let capturedUser = "";
    const fakeLLM: ChatLike = {
      async chatComplete(_system, user) { capturedUser = user; return "It is about quantum physics [1]."; },
    };
    const res = await askWiki(store, "quantum physics", cfg, fakeLLM, { embedFn: fakeEmbed });
    expect(res.generated).toBe(true);
    expect(res.method).toBe("semantic");
    expect(res.answer).toContain("[1]");
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0].slug).toBe("quantum");
    // Context passages were injected into the prompt.
    expect(capturedUser).toContain("quantum");
  });

  test("askWiki without LLM returns passages (not generated)", async () => {
    const res = await askWiki(store, "quantum physics", cfg, null, { embedFn: fakeEmbed });
    expect(res.generated).toBe(false);
    expect(res.citations.length).toBeGreaterThan(0);
  });

  test("askWiki falls back to keyword retrieval when no embeddings exist", async () => {
    const empty = new Store(":memory:");
    empty.initSchema();
    empty.addPage("fts-page", "Machine Learning", "machine learning is fun and useful", undefined, undefined, "concept", 0);
    const res = await askWiki(empty, "machine learning", cfg, null, { embedFn: fakeEmbed });
    expect(res.method).toBe("keyword");
    empty.close();
  });
});

describe("keywordRetrieve", () => {
  test("returns pages via store search", () => {
    const store = new Store(":memory:");
    store.initSchema();
    store.addPage("ml", "Machine Learning", "machine learning content here", undefined, undefined, "concept", 0);
    const results = keywordRetrieve(store, "machine learning", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe("ml");
    store.close();
  });
});
