import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { azureCredentialFile, estimateCostUsd, LLMClient, LlmDeadlineExceededError, ollamaEmbedding } from "./llm-client";

describe("model-aware cost estimates", () => {
  test("uses current standard prices for supported default models", () => {
    expect(estimateCostUsd("gemini", "gemini-3.1-flash-lite", 1_000_000, 1_000_000)).toBe(1.75);
    expect(estimateCostUsd("openai", "gpt-5.4-nano", 1_000_000, 1_000_000)).toBe(1.45);
    expect(estimateCostUsd("openai", "gpt-5.4", 1_000_000, 1_000_000)).toBe(17.5);
    expect(estimateCostUsd("anthropic", "claude-sonnet-4-6", 1_000_000, 1_000_000)).toBe(18);
  });

  test("does not invent a price for custom models or Azure deployments", () => {
    expect(estimateCostUsd("gemini", "custom-model", 100, 50)).toBeNull();
    expect(estimateCostUsd("azure-openai", "gpt-5.4-nano", 100, 50)).toBeNull();
  });

  test("zero usage has zero cost even when pricing is unknown", () => {
    expect(estimateCostUsd("custom-provider", "custom-model", 0, 0)).toBe(0);
  });

  test("treats Ollama as free regardless of model or token usage", () => {
    expect(estimateCostUsd("ollama", "llama3.1", 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCostUsd("ollama", "any-local-model", 500, 500)).toBe(0);
  });

  test("does not invent a price for OpenRouter's model-specific billing", () => {
    expect(estimateCostUsd("openrouter", "openrouter/auto", 100, 50)).toBeNull();
  });
});

describe("Azure local credential path", () => {
  test("accepts one deployment filename component and rejects traversal before lookup", () => {
    expect(azureCredentialFile("/home/user", "deployment_v1.2-test"))
      .toBe("/home/user/keys/openai.azure.com/deployment_v1.2-test.json");
    for (const model of ["../outside", "nested/deployment", "..", ".", "\\outside"]) {
      expect(() => azureCredentialFile("/home/user", model)).toThrow("API key not configured");
    }
  });

  test("rejects traversal before any credential JSON read", async () => {
    const read = spyOn(fs, "readFileSync");
    try {
      const client = new LLMClient({
        provider: "azure-openai",
        model: "../../outside",
        api_key: "",
        endpoint: "https://resource.openai.azure.com",
      });
      await expect(client.chatComplete("system", "user")).rejects.toThrow("API key not configured");
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});

describe("LLM request deadline", () => {
  const config = { provider: "gemini", model: "gemini-3.1-flash-lite", api_key: "test", endpoint: "" };

  test("aborts a hanging Gemini request at the client deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    }) as unknown as typeof fetch;
    const client = new LLMClient(config, { deadlineMs: 10, fetch: hangingFetch });

    await expect(client.chatComplete("system", "user")).rejects.toBeInstanceOf(LlmDeadlineExceededError);
    expect(observedSignal?.aborted).toBeTrue();
  });

  test("returns at the deadline even when an injected transport ignores AbortSignal", async () => {
    const ignoringFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const client = new LLMClient(config, { deadlineMs: 10, fetch: ignoringFetch });

    await expect(client.chatComplete("system", "user")).rejects.toBeInstanceOf(LlmDeadlineExceededError);
  });

  test("composes a parent cancellation signal with the request deadline", async () => {
    const reason = new Error("server shutdown");
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const client = new LLMClient(config, {
      deadlineMs: 10_000,
      fetch: hangingFetch,
      signal: controller.signal,
    });

    const completion = client.chatComplete("system", "user");
    controller.abort(reason);
    await expect(completion).rejects.toBe(reason);
    expect(observedSignal?.aborted).toBeTrue();
    expect(observedSignal?.reason).toBe(reason);
  });

  test("does not start a retry sleep that exceeds the remaining deadline", async () => {
    let sleepCalls = 0;
    const busyFetch = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    const client = new LLMClient(config, {
      deadlineMs: 100,
      fetch: busyFetch,
      random: () => 0,
      sleep: async () => { sleepCalls++; },
    });

    await expect(client.chatComplete("system", "user")).rejects.toBeInstanceOf(LlmDeadlineExceededError);
    expect(sleepCalls).toBe(0);
  });

  test("retries a transient 5xx once when the delay fits, then succeeds", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) return new Response("temporary", { status: 502 });
      return Response.json({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    }) as unknown as typeof fetch;
    const client = new LLMClient(config, {
      deadlineMs: 5_000,
      fetch: fetchFn,
      random: () => 0,
      sleep: async () => {},
    });

    await expect(client.chatComplete("system", "user")).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  test("rejects invalid deadline configuration", () => {
    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => new LLMClient(config, { deadlineMs })).toThrow(RangeError);
    }
  });
});

describe("Ollama provider", () => {
  test("routes chat to {base}/api/chat, tracks usage, and stays free", async () => {
    let calledUrl = "";
    const fetchFn = (async (input: string | URL | Request) => {
      calledUrl = String(input);
      return Response.json({
        message: { role: "assistant", content: "안녕하세요" },
        prompt_eval_count: 12,
        eval_count: 8,
        done: true,
      });
    }) as unknown as typeof fetch;
    const client = new LLMClient(
      { provider: "ollama", model: "llama3.1", api_key: "", endpoint: "" },
      { fetch: fetchFn },
    );

    await expect(client.chatComplete("system", "user")).resolves.toBe("안녕하세요");
    expect(calledUrl).toBe("http://localhost:11434/api/chat");
    const usage = client.getUsageStats();
    expect(usage.promptTokens).toBe(12);
    expect(usage.completionTokens).toBe(8);
    expect(usage.totalTokens).toBe(20);
    expect(client.getEstimatedCost()).toBe(0);
  });

  test("honors a custom endpoint and strips trailing slashes", async () => {
    let calledUrl = "";
    const fetchFn = (async (input: string | URL | Request) => {
      calledUrl = String(input);
      return Response.json({ message: { content: "x" } });
    }) as unknown as typeof fetch;
    const client = new LLMClient(
      { provider: "ollama", model: "llama3.1", api_key: "", endpoint: "http://ollama.local:1234/" },
      { fetch: fetchFn },
    );

    await client.chatComplete("s", "u");
    expect(calledUrl).toBe("http://ollama.local:1234/api/chat");
  });

  test("surfaces an actionable error when the daemon is unreachable", async () => {
    const fetchFn = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const client = new LLMClient(
      { provider: "ollama", model: "llama3.1", api_key: "", endpoint: "" },
      { fetch: fetchFn },
    );

    await expect(client.chatComplete("system", "user")).rejects.toThrow("Ollama에 연결할 수 없습니다");
  });

  test("embeddings hit /api/embeddings and return a Float32Array", async () => {
    let calledUrl = "";
    const fetchFn = (async (input: string | URL | Request) => {
      calledUrl = String(input);
      return Response.json({ embedding: [0.1, 0.2, 0.3] });
    }) as unknown as typeof fetch;

    const vec = await ollamaEmbedding(
      "hello",
      { model: "nomic-embed-text", endpoint: "" },
      fetchFn,
      new AbortController().signal,
    );

    expect(calledUrl).toBe("http://localhost:11434/api/embeddings");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(3);
    expect(vec[0]).toBeCloseTo(0.1, 5);
  });

  test("embeddings report an actionable error when unreachable", async () => {
    const fetchFn = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(
      ollamaEmbedding("hi", { model: "nomic-embed-text", endpoint: "" }, fetchFn, new AbortController().signal),
    ).rejects.toThrow("Ollama에 연결할 수 없습니다");
  });
});

describe("OpenRouter provider", () => {
  test("sends a Bearer auth header to the v1 chat endpoint and returns content", async () => {
    let calledUrl = "";
    let authHeader: string | null | undefined;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(input);
      authHeader = new Headers(init?.headers).get("authorization");
      return Response.json({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      });
    }) as unknown as typeof fetch;
    const client = new LLMClient(
      { provider: "openrouter", model: "openrouter/auto", api_key: "sk-or-test", endpoint: "" },
      { fetch: fetchFn },
    );

    await expect(client.chatComplete("system", "user")).resolves.toBe("hi");
    expect(calledUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(authHeader).toBe("Bearer sk-or-test");
    // Model-specific billing is unknown → tracked tokens but no invented price.
    expect(client.getEstimatedCost()).toBeNull();
    expect(client.getUsageStats().totalTokens).toBe(7);
  });

  test("reports an auth failure on 401 without retrying", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;
    const client = new LLMClient(
      { provider: "openrouter", model: "openrouter/auto", api_key: "bad-key", endpoint: "" },
      { fetch: fetchFn, sleep: async () => {}, random: () => 0 },
    );

    await expect(client.chatComplete("system", "user")).rejects.toThrow("401");
    expect(calls).toBe(1);
  });
});
