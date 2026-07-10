import { importAnthropic, importOpenAI } from "./optional-deps";
import type { LLMConfig } from "./config";

// Token usage tracking
export interface UsageStats {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ── Pricing (per 1M tokens, approximate) ──
export const PRICING: Record<string, { input: number; output: number }> = {
  "gemini": { input: 0.075, output: 0.30 },
  "azure-openai": { input: 0.10, output: 0.40 },
  "openai": { input: 2.50, output: 10.00 },
  "anthropic": { input: 3.00, output: 15.00 },
};

/** Estimate USD cost for a given provider and token counts. */
export function estimateCostUsd(provider: string, promptTokens: number, completionTokens: number): number {
  const p = PRICING[provider] || PRICING["gemini"];
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
}

/** Providers with multimodal (image) input support used for figure captioning. */
const VISION_PROVIDERS = new Set(["gemini", "anthropic", "openai"]);

/** Whether a provider supports vision/image input (for figure captioning). */
export function supportsVision(provider: string): boolean {
  return VISION_PROVIDERS.has(provider);
}

// ── Provider implementations ──

async function geminiComplete(config: LLMConfig, system: string, userMessage: string, maxTokens: number): Promise<{ text: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.api_key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error (${resp.status}): ${err.slice(0, 200)}`);
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

// ── Class-based LLM client ──

type ProviderResult = { text: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // Gemini: raw fetch, status in error message
    if (/\b(429|503)\b/.test(error.message)) return true;
  }
  // OpenAI/Azure/Anthropic SDKs: error objects with status property
  const status = (error as any)?.status;
  if (status === 429 || status === 503) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class LLMClient {
  private config: LLMConfig;
  private usage: UsageStats = { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private _openaiClient: InstanceType<typeof import("openai").default> | null = null;
  private _anthropicClient: InstanceType<typeof import("@anthropic-ai/sdk").default> | null = null;
  private _azureClient: InstanceType<typeof import("openai").AzureOpenAI> | null = null;

  onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  private async azureComplete(system: string, userMessage: string, maxTokens: number): Promise<ProviderResult> {
    let apiKey = this.config.api_key;
    let endpoint = this.config.endpoint;
    let model = this.config.model;

    if (!apiKey) {
      try {
        const keyFile = `${process.env.HOME}/keys/openai.azure.com/${this.config.model}.json`;
        const { readFileSync } = await import("fs");
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
    });

    return {
      text: resp.choices[0]?.message?.content || "",
      usage: resp.usage ? {
        prompt_tokens: resp.usage.prompt_tokens || 0,
        completion_tokens: resp.usage.completion_tokens || 0,
        total_tokens: resp.usage.total_tokens || 0,
      } : undefined,
    };
  }

  private async openaiComplete(system: string, userMessage: string, maxTokens: number): Promise<ProviderResult> {
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
    });
    return {
      text: resp.choices[0]?.message?.content || "",
      usage: resp.usage ? {
        prompt_tokens: resp.usage.prompt_tokens || 0,
        completion_tokens: resp.usage.completion_tokens || 0,
        total_tokens: resp.usage.total_tokens || 0,
      } : undefined,
    };
  }

  private async anthropicComplete(system: string, userMessage: string, maxTokens: number): Promise<ProviderResult> {
    const { default: Anthropic } = await importAnthropic();
    if (!this._anthropicClient) {
      this._anthropicClient = new Anthropic({ apiKey: this.config.api_key });
    }
    const resp = await this._anthropicClient.messages.create({
      model: this.config.model || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system: system,
      messages: [{ role: "user", content: userMessage }],
    });
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

  async chatComplete(system: string, userMessage: string, maxTokens = 8192): Promise<string> {
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 2000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        let result: ProviderResult;

        switch (this.config.provider) {
          case "gemini":
            result = await geminiComplete(this.config, system, userMessage, maxTokens);
            break;
          case "azure-openai":
            result = await this.azureComplete(system, userMessage, maxTokens);
            break;
          case "openai":
            result = await this.openaiComplete(system, userMessage, maxTokens);
            break;
          case "anthropic":
            result = await this.anthropicComplete(system, userMessage, maxTokens);
            break;
          default:
            throw new Error(`Unknown LLM provider: ${this.config.provider}`);
        }

        // Track usage
        if (result.usage) {
          this.usage.totalCalls++;
          this.usage.promptTokens += result.usage.prompt_tokens || 0;
          this.usage.completionTokens += result.usage.completion_tokens || 0;
          this.usage.totalTokens += result.usage.total_tokens || 0;
        }

        return result.text;
      } catch (error) {
        if (isRetryableError(error) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
          this.onRetry?.(attempt + 1, MAX_RETRIES, delay);
          await sleep(delay);
          continue;
        }
        throw error;
      }
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

  getEstimatedCost(): number {
    return estimateCostUsd(this.config.provider, this.usage.promptTokens, this.usage.completionTokens);
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

    let result: ProviderResult;
    switch (this.config.provider) {
      case "gemini":
        result = await this.geminiVision(imageBase64, mimeType, prompt, maxTokens);
        break;
      case "anthropic":
        result = await this.anthropicVision(imageBase64, mimeType, prompt, maxTokens);
        break;
      case "openai":
        result = await this.openaiVision(imageBase64, mimeType, prompt, maxTokens);
        break;
      default:
        return null;
    }

    if (result.usage) {
      this.usage.totalCalls++;
      this.usage.promptTokens += result.usage.prompt_tokens || 0;
      this.usage.completionTokens += result.usage.completion_tokens || 0;
      this.usage.totalTokens += result.usage.total_tokens || 0;
    }
    return result.text;
  }

  private async geminiVision(imageBase64: string, mimeType: string, prompt: string, maxTokens: number): Promise<ProviderResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.config.api_key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini vision error (${resp.status}): ${err.slice(0, 200)}`);
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

  private async anthropicVision(imageBase64: string, mimeType: string, prompt: string, maxTokens: number): Promise<ProviderResult> {
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
    });
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

  private async openaiVision(imageBase64: string, mimeType: string, prompt: string, maxTokens: number): Promise<ProviderResult> {
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
    });
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
    console.log(`  예상 비용:     ~$${cost.toFixed(4)}`);
  }
}

