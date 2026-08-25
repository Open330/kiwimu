import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../store";
import type { LLMConfig } from "../config";
import {
  embeddingModelIdentity,
  EmbeddingDeadlineExceededError,
  getEmbedding,
} from "./embedding";

describe("embedding model identity", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => store.close());

  test("identifies the actual provider-specific embedding vector space", () => {
    expect(embeddingModelIdentity({ provider: "gemini", endpoint: "", model: "" })).toBe("gemini:gemini-embedding-001");
    expect(embeddingModelIdentity({ provider: "openai", endpoint: "", model: "" })).toBe("openai:text-embedding-3-small");
    expect(embeddingModelIdentity({ provider: "azure-openai", endpoint: "https://EXAMPLE.openai.azure.com/", model: "" }))
      .toBe("azure-openai:https://example.openai.azure.com:text-embedding-3-small");
    expect(embeddingModelIdentity({ provider: "ollama", endpoint: "", model: "nomic-embed-text" }))
      .toBe("ollama:http://localhost:11434:nomic-embed-text");
    expect(embeddingModelIdentity({ provider: "anthropic", endpoint: "", model: "" })).toBeNull();
  });

  test("marks a page for re-embedding and filters retrieval after a model switch", () => {
    const page = store.addPage("page", "Page", "content");
    store.saveEmbedding(page.id, new Float32Array([1, 0]), "openai:text-embedding-3-small");

    expect(store.getPagesWithoutEmbeddings("gemini:gemini-embedding-001").map(row => row.id)).toEqual([page.id]);
    expect(store.getAllEmbeddings("gemini:gemini-embedding-001")).toHaveLength(0);

    store.saveEmbedding(page.id, new Float32Array([0, 1, 0]), "gemini:gemini-embedding-001");
    expect(store.getPagesWithoutEmbeddings("gemini:gemini-embedding-001")).toHaveLength(0);
    expect(store.getAllEmbeddings("openai:text-embedding-3-small")).toHaveLength(0);
    expect(store.getAllEmbeddings("gemini:gemini-embedding-001")).toHaveLength(1);
  });

  test("stores only the bytes in a Float32Array view", () => {
    const page = store.addPage("view", "View", "content");
    const view = new Float32Array([9, 1, 2, 8]).subarray(1, 3);
    store.saveEmbedding(page.id, view, "openai:text-embedding-3-small");

    const [stored] = store.getAllEmbeddings("openai:text-embedding-3-small");
    expect(Array.from(stored.embedding)).toEqual([1, 2]);
  });
});

describe("embedding request deadline", () => {
  const configs: LLMConfig[] = [
    { provider: "gemini", model: "chat", api_key: "test", endpoint: "" },
    { provider: "openai", model: "chat", api_key: "test", endpoint: "" },
    { provider: "azure-openai", model: "chat", api_key: "test", endpoint: "https://example.openai.azure.com" },
  ];

  test("bounds every supported provider even when transport ignores AbortSignal", async () => {
    const hangingFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    for (const config of configs) {
      await expect(getEmbedding("text", config, { deadlineMs: 10, fetch: hangingFetch }))
        .rejects.toBeInstanceOf(EmbeddingDeadlineExceededError);
    }
  });

  test("passes an abort signal to the transport", async () => {
    let observedSignal: AbortSignal | null = null;
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal | null;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    }) as unknown as typeof fetch;

    await expect(getEmbedding("text", configs[0], { deadlineMs: 10, fetch: hangingFetch }))
      .rejects.toBeInstanceOf(EmbeddingDeadlineExceededError);
    expect((observedSignal as AbortSignal | null)?.aborted).toBeTrue();
  });

  test("preserves caller cancellation instead of rewriting it as a deadline", async () => {
    const reason = new Error("shutdown interrupted embedding");
    const controller = new AbortController();
    const hangingFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const completion = getEmbedding("text", configs[0], {
      deadlineMs: 10_000,
      fetch: hangingFetch,
      signal: controller.signal,
    });

    controller.abort(reason);
    await expect(completion).rejects.toBe(reason);
  });
});
