import { importAnthropic, importOpenAI } from "./optional-deps";
import { DEFAULT_OLLAMA_BASE_URL, type LLMConfig } from "./config";
import { abortReason, withAbortDeadline } from "./abort";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Token usage tracking
export interface UsageStats {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const DEFAULT_LLM_DEADLINE_MS = 120_000;

export class LlmDeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`LLM request could not complete within the ${deadlineMs}ms deadline`);
    this.name = "LlmDeadlineExceededError";
  }
}

export interface LLMClientOptions {
  deadlineMs?: number;
  /** Cancels every request made by this client, e.g. when its server job stops. */
  signal?: AbortSignal;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// ── Standard API pricing (USD per 1M tokens) ──
// Prices are keyed by the exact provider/model pair. A provider fallback would
// make custom deployments look cheaper or more expensive with false precision.
export const MODEL_PRICING: Readonly<Record<string, { input: number; output: number }>> = {
  "gemini:gemini-3.1-flash-lite": { input: 0.25, output: 1.50 },
  "openai:gpt-5.4-nano": { input: 0.20, output: 1.25 },
  "openai:gpt-5.4": { input: 2.50, output: 15.00 },
  "anthropic:claude-sonnet-4-6": { input: 3.00, output: 15.00 },
};

/** Return null when the configured model has no verified standard price. */
export function estimateCostUsd(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (promptTokens === 0 && completionTokens === 0) return 0;
  // Ollama runs locally: no per-token billing regardless of model.
  if (provider.trim().toLowerCase() === "ollama") return 0;
  const p = MODEL_PRICING[`${provider.trim().toLowerCase()}:${model.trim().toLowerCase()}`];
  if (!p) return null;
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
}

/** Providers with multimodal (image) input support used for figure captioning. */
const VISION_PROVIDERS = new Set(["gemini", "anthropic", "openai"]);
const SAFE_AZURE_DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Whether a provider supports vision/image input (for figure captioning). */
export function supportsVision(provider: string): boolean {
  return VISION_PROVIDERS.has(provider);
}

/** Constrain the legacy local Azure credential lookup to one filename component. */
export function azureCredentialFile(home: string | undefined, model: string): string {
  if (!home || !SAFE_AZURE_DEPLOYMENT.test(model)) {
    throw new Error("Azure OpenAI API key not configured");
  }
  return join(home, "keys", "openai.azure.com", `${model}.json`);
}

// ── Provider implementations ──

async function geminiComplete(
  config: LLMConfig,
  system: string,
  userMessage: string,
  maxTokens: number,
  signal: AbortSignal,
  fetchFn: typeof fetch,
): Promise<{ text: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.api_key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
    }),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new ProviderHttpError(`Gemini API error (${resp.status}): ${err.slice(0, 200)}`, resp.status);
  }

  const data = await resp.json() as Record<string, unknown>;
  const candidates = data.candidates as Array<{ content: { parts: Array<{ text: string }> } }> | undefined;
  const text = candidates?.[0]?.content?.parts?.[0]?.text || "";
  const usage = data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;
  return {
    text,
    usage: usage ? {
      prompt_tokens: usage.promptTokenCount || 0,
      completion_tokens: usage.candidatesTokenCount || 0,
      total_tokens: usage.totalTokenCount || 0,
    } : undefined,
  };
}

/** Resolve the Ollama base URL from config, falling back to the local default. */
function ollamaBaseUrl(config: Pick<LLMConfig, "endpoint">): string {
  return (config.endpoint?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
}

/** Actionable error shown when the local Ollama daemon cannot be reached. */
function ollamaUnreachableError(base: string): Error {
  return new Error(`Ollama에 연결할 수 없습니다: ${base}. \`ollama serve\` 실행 여부를 확인하세요.`);
}

/**
 * Ollama-native embeddings (POST {base}/api/embeddings) — local and free.
 * Exported so the embedding pipeline (src/services/embedding.ts) can offer
 * local vectors: add an `ollama` case there that delegates here. Throws a
 * clear, actionable error when the daemon is unreachable.
 */
export async function ollamaEmbedding(
  text: string,
  config: Pick<LLMConfig, "model" | "endpoint">,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<Float32Array> {
  const base = ollamaBaseUrl(config);
  let resp: Response;
  try {
    resp = await fetchFn(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, prompt: text }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw ollamaUnreachableError(base);
  }
  if (!resp.ok) throw new Error(`Ollama embedding error (${resp.status})`);
  const data = await resp.json() as { embedding?: number[] };
  if (!data.embedding) throw new Error("Ollama embedding 응답에 embedding 필드가 없습니다.");
  return new Float32Array(data.embedding);
}

// ── Class-based LLM client ──

type ProviderResult = { text: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };

class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isRetryableError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && (status === 429 || (status >= 500 && status <= 599));
}

export class LLMClient {
  private config: LLMConfig;
  private usage: UsageStats = { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private _openaiClient: InstanceType<typeof import("openai").default> | null = null;
  private _anthropicClient: InstanceType<typeof import("@anthropic-ai/sdk").default> | null = null;
  private _azureClient: InstanceType<typeof import("openai").AzureOpenAI> | null = null;
  private readonly deadlineMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly parentSignal: AbortSignal | undefined;

  onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;

  constructor(config: LLMConfig, options: LLMClientOptions = {}) {
    this.config = config;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_LLM_DEADLINE_MS;
    if (!Number.isFinite(this.deadlineMs) || !Number.isInteger(this.deadlineMs) || this.deadlineMs < 1) {
      throw new RangeError("LLM deadlineMs must be a positive finite integer");
    }
    this.fetchFn = options.fetch ?? fetch;
    this.sleepFn = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.parentSignal = options.signal;
  }

  private remainingMs(deadlineAt: number): number {
    return Math.max(1, deadlineAt - Date.now());
  }

  private async azureComplete(
    system: string,
    userMessage: string,
    maxTokens: number,
    signal: AbortSignal,
    timeout: number,
  ): Promise<ProviderResult> {
    let apiKey = this.config.api_key;
    let endpoint = this.config.endpoint;
    let model = this.config.model;

    if (!apiKey) {
      try {
        const keyFile = azureCredentialFile(process.env.HOME, this.config.model);
        const raw = readFileSync(keyFile, "utf-8");
        const keyConfig = JSON.parse(raw)[0] as { key: string; endpoint: string; deployment: string };
        apiKey = keyConfig.key;
        endpoint = keyConfig.endpoint.split("/openai/")[0];
        model = keyConfig.deployment;
      } catch {
        throw new Error("Azure OpenAI API key not configured");
      }
    }

    if (!this._azureClient) {
      const { AzureOpenAI } = await importOpenAI();
      this._azureClient = new AzureOpenAI({ endpoint, apiKey, deployment: model, apiVersion: "2024-12-01-preview" });
    }

    const resp = await this._azureClient.chat.completions.create({
      model: model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    }, { signal, timeout, maxRetries: 0 });

    return {
      text: resp.choices[0]?.message?.content || "",
      usage: resp.usage ? {
        prompt_tokens: resp.usage.prompt_tokens || 0,
        completion_tokens: resp.usage.completion_tokens || 0,
        total_tokens: resp.usage.total_tokens || 0,
      } : undefined,
    };
  }

  private async openaiComplete(
    system: string,
    userMessage: string,
    maxTokens: number,
    signal: AbortSignal,
    timeout: number,
  ): Promise<ProviderResult> {
    const { default: OpenAI } = await importOpenAI();
    if (!this._openaiClient) {
      this._openaiClient = new OpenAI({ apiKey: this.config.api_key });
    }
    const resp = await this._openaiClient.chat.completions.create({
      model: this.config.model || "gpt-5.4",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
      max_tokens: maxTokens,
    }, { signal, timeout, maxRetries: 0 });
    return {
      text: resp.choices[0]?.message?.content || "",
      usage: resp.usage ? {
        prompt_tokens: resp.usage.prompt_tokens || 0,
        completion_tokens: resp.usage.completion_tokens || 0,
        total_tokens: resp.usage.total_tokens || 0,
      } : undefined,
    };
  }

  private async anthropicComplete(
    system: string,
    userMessage: string,
    maxTokens: number,
    signal: AbortSignal,
    timeout: number,
  ): Promise<ProviderResult> {
    const { default: Anthropic } = await importAnthropic();
    if (!this._anthropicClient) {
      this._anthropicClient = new Anthropic({ apiKey: this.config.api_key });
    }
    const resp = await this._anthropicClient.messages.create({
      model: this.config.model || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system: system,
      messages: [{ role: "user", content: userMessage }],
    }, { signal, timeout, maxRetries: 0 });
    const content = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    return {
      text: content,
      usage: resp.usage ? {
        prompt_tokens: resp.usage.input_tokens || 0,
        completion_tokens: resp.usage.output_tokens || 0,
        total_tokens: (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0),
      } : undefined,
    };
  }

  private async ollamaComplete(
    system: string,
    userMessage: string,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    const base = ollamaBaseUrl(this.config);
    let resp: Response;
    try {
      resp = await this.fetchFn(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMessage },
          ],
          stream: false,
          options: { num_predict: maxTokens, temperature: 0.7 },
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw ollamaUnreachableError(base);
    }
    if (!resp.ok) {
      const err = await resp.text();
      throw new ProviderHttpError(`Ollama API error (${resp.status}): ${err.slice(0, 200)}`, resp.status);
    }
    const data = await resp.json() as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const promptTokens = data.prompt_eval_count || 0;
    const completionTokens = data.eval_count || 0;
    return {
      text: data.message?.content || "",
      usage: (promptTokens || completionTokens) ? {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      } : undefined,
    };
  }

  private async openrouterComplete(
    system: string,
    userMessage: string,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    const url = "https://openrouter.ai/api/v1/chat/completions";
    let resp: Response;
    try {
      resp = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.api_key}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMessage },
          ],
          max_tokens: maxTokens,
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`OpenRouter에 연결할 수 없습니다: ${url}. 네트워크 연결을 확인하세요.`);
    }
    if (!resp.ok) {
      const err = await resp.text();
      if (resp.status === 401) {
        throw new ProviderHttpError("OpenRouter 인증 실패 (401): API key를 확인하세요 (openrouter.ai/keys).", resp.status);
      }
      throw new ProviderHttpError(`OpenRouter API error (${resp.status}): ${err.slice(0, 200)}`, resp.status);
    }
    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content || "",
      usage: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens || 0,
        completion_tokens: data.usage.completion_tokens || 0,
        total_tokens: data.usage.total_tokens || 0,
      } : undefined,
    };
  }

  async chatComplete(system: string, userMessage: string, maxTokens = 8192): Promise<string> {
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 2000;
    const timeoutError = new LlmDeadlineExceededError(this.deadlineMs);
    const deadline = withAbortDeadline(this.deadlineMs, timeoutError, this.parentSignal);
    const deadlineAt = Date.now() + this.deadlineMs;

    try {
      if (deadline.signal.aborted) throw abortReason(deadline.signal);
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          let operation: Promise<ProviderResult>;
          const remaining = this.remainingMs(deadlineAt);

          switch (this.config.provider) {
            case "gemini":
              operation = geminiComplete(this.config, system, userMessage, maxTokens, deadline.signal, this.fetchFn);
              break;
            case "azure-openai":
              operation = this.azureComplete(system, userMessage, maxTokens, deadline.signal, remaining);
              break;
            case "openai":
              operation = this.openaiComplete(system, userMessage, maxTokens, deadline.signal, remaining);
              break;
            case "anthropic":
              operation = this.anthropicComplete(system, userMessage, maxTokens, deadline.signal, remaining);
              break;
            case "ollama":
              operation = this.ollamaComplete(system, userMessage, maxTokens, deadline.signal);
              break;
            case "openrouter":
              operation = this.openrouterComplete(system, userMessage, maxTokens, deadline.signal);
              break;
            default:
              throw new Error(`Unknown LLM provider: ${this.config.provider}`);
          }
          const result = await raceWithAbort(operation, deadline.signal);

          // Track usage
          if (result.usage) {
            this.usage.totalCalls++;
            this.usage.promptTokens += result.usage.prompt_tokens || 0;
            this.usage.completionTokens += result.usage.completion_tokens || 0;
            this.usage.totalTokens += result.usage.total_tokens || 0;
          }

          return result.text;
        } catch (error) {
          if (deadline.signal.aborted) throw abortReason(deadline.signal);
          if (isRetryableError(error) && attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt) + this.random() * 1000;
            if (delay >= this.remainingMs(deadlineAt)) throw timeoutError;
            this.onRetry?.(attempt + 1, MAX_RETRIES, delay);
            await raceWithAbort(this.sleepFn(delay), deadline.signal);
            continue;
          }
          throw error;
        }
      }
    } finally {
      deadline.cleanup();
    }

    throw new Error("Unreachable: retry loop exited without return or throw");
  }

  getUsageStats(): UsageStats {
    return { ...this.usage };
  }

  resetUsageStats(): void {
    this.usage.totalCalls = 0;
    this.usage.promptTokens = 0;
    this.usage.completionTokens = 0;
    this.usage.totalTokens = 0;
  }

  getEstimatedCost(): number | null {
    return estimateCostUsd(
      this.config.provider,
      this.config.model,
      this.usage.promptTokens,
      this.usage.completionTokens,
    );
  }

  /** Whether the configured provider supports image/vision input. */
  supportsVision(): boolean {
    return supportsVision(this.config.provider);
  }

  /**
   * Describe/caption an image via the provider's multimodal API.
   * Returns null if the provider does not support vision (graceful skip).
   * Throws on API errors so callers can decide whether to continue.
   */
  async describeImage(imageBase64: string, mimeType: string, prompt: string, maxTokens = 512): Promise<string | null> {
    if (!this.supportsVision()) return null;

    const timeoutError = new LlmDeadlineExceededError(this.deadlineMs);
    const deadline = withAbortDeadline(this.deadlineMs, timeoutError, this.parentSignal);
    const deadlineAt = Date.now() + this.deadlineMs;
    try {
      if (deadline.signal.aborted) throw abortReason(deadline.signal);
      let operation: Promise<ProviderResult>;
      switch (this.config.provider) {
        case "gemini":
          operation = this.geminiVision(imageBase64, mimeType, prompt, maxTokens, deadline.signal);
          break;
        case "anthropic":
          operation = this.anthropicVision(
            imageBase64,
            mimeType,
            prompt,
            maxTokens,
            deadline.signal,
            this.remainingMs(deadlineAt),
          );
          break;
        case "openai":
          operation = this.openaiVision(
            imageBase64,
            mimeType,
            prompt,
            maxTokens,
            deadline.signal,
            this.remainingMs(deadlineAt),
          );
          break;
        default:
          return null;
      }
      const result = await raceWithAbort(operation, deadline.signal);

      if (result.usage) {
        this.usage.totalCalls++;
        this.usage.promptTokens += result.usage.prompt_tokens || 0;
        this.usage.completionTokens += result.usage.completion_tokens || 0;
        this.usage.totalTokens += result.usage.total_tokens || 0;
      }
      return result.text;
    } catch (error) {
      if (deadline.signal.aborted) throw abortReason(deadline.signal);
      throw error;
    } finally {
      deadline.cleanup();
    }

  }

  private async geminiVision(
    imageBase64: string,
    mimeType: string,
    prompt: string,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`;
    const resp = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.config.api_key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
      }),
      signal,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new ProviderHttpError(`Gemini vision error (${resp.status}): ${err.slice(0, 200)}`, resp.status);
    }
    const data = await resp.json() as Record<string, unknown>;
    const candidates = data.candidates as Array<{ content: { parts: Array<{ text: string }> } }> | undefined;
    const usage = data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;
    return {
      text: candidates?.[0]?.content?.parts?.[0]?.text || "",
      usage: usage ? {
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0,
      } : undefined,
    };
  }

  private async anthropicVision(
    imageBase64: string,
    mimeType: string,
    prompt: string,
    maxTokens: number,
    signal: AbortSignal,
    timeout: number,
  ): Promise<ProviderResult> {
    const { default: Anthropic } = await importAnthropic();
    if (!this._anthropicClient) {
      this._anthropicClient = new Anthropic({ apiKey: this.config.api_key });
    }
    const resp = await this._anthropicClient.messages.create({
      model: this.config.model || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType as any, data: imageBase64 } },
          { type: "text", text: prompt },
        ],
      }],
    }, { signal, timeout });
    const content = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    return {
      text: content,
      usage: resp.usage ? {
        prompt_tokens: resp.usage.input_tokens || 0,
        completion_tokens: resp.usage.output_tokens || 0,
        total_tokens: (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0),
      } : undefined,
    };
  }

  private async openaiVision(
    imageBase64: string,
    mimeType: string,
    prompt: string,
    maxTokens: number,
    signal: AbortSignal,
    timeout: number,
  ): Promise<ProviderResult> {
    const { default: OpenAI } = await importOpenAI();
    if (!this._openaiClient) {
      this._openaiClient = new OpenAI({ apiKey: this.config.api_key });
    }
    const resp = await this._openaiClient.chat.completions.create({
      model: this.config.model || "gpt-5.4",
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ] as any,
      }],
    }, { signal, timeout });
    return {
      text: resp.choices[0]?.message?.content || "",
      usage: resp.usage ? {
        prompt_tokens: resp.usage.prompt_tokens || 0,
        completion_tokens: resp.usage.completion_tokens || 0,
        total_tokens: resp.usage.total_tokens || 0,
      } : undefined,
    };
  }

  printUsageSummary(): void {
    const u = this.usage;
    const cost = this.getEstimatedCost();

    console.log(`\x1b[34m📊 LLM 사용량 (${this.config.provider}/${this.config.model}):\x1b[0m`);
    console.log(`  호출 횟수:     ${u.totalCalls}회`);
    console.log(`  입력 토큰:     ${u.promptTokens.toLocaleString()}`);
    console.log(`  출력 토큰:     ${u.completionTokens.toLocaleString()}`);
    console.log(`  총 토큰:       ${u.totalTokens.toLocaleString()}`);
    console.log(cost === null
      ? "  예상 비용:     가격 정보 없음 (토큰 사용량만 기록)"
      : `  예상 비용:     ~$${cost.toFixed(4)}`);
  }
}
