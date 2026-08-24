import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { azureCredentialFile, estimateCostUsd, LLMClient, LlmDeadlineExceededError } from "./llm-client";

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
