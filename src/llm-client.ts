import type { LLMConfig } from "./config";

// Token usage tracking
export interface UsageStats {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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

export class LLMClient {
  private config: LLMConfig;
  private usage: UsageStats = { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private _openaiClient: InstanceType<typeof import("openai").default> | null = null;
  private _anthropicClient: InstanceType<typeof import("@anthropic-ai/sdk").default> | null = null;
  private _azureClient: InstanceType<typeof import("openai").AzureOpenAI> | null = null;

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
        const raw = require("fs").readFileSync(keyFile, "utf-8");
        const keyConfig = JSON.parse(raw)[0] as { key: string; endpoint: string; deployment: string };
        apiKey = keyConfig.key;
        endpoint = keyConfig.endpoint.split("/openai/")[0];
        model = keyConfig.deployment;
      } catch {
        throw new Error("Azure OpenAI API key not configured");
      }
    }

    if (!this._azureClient) {
      const { AzureOpenAI } = await import("openai");
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
    const { default: OpenAI } = await import("openai");
    if (!this._openaiClient) {
      this._openaiClient = new OpenAI({ apiKey: this.config.api_key });
    }
    const resp = await this._openaiClient.chat.completions.create({
      model: this.config.model || "gpt-4o",
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
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    if (!this._anthropicClient) {
      this._anthropicClient = new Anthropic({ apiKey: this.config.api_key });
    }
    const resp = await this._anthropicClient.messages.create({
      model: this.config.model || "claude-sonnet-4-20250514",
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
    // Pricing per 1M tokens (approximate)
    const pricing: Record<string, { input: number; output: number }> = {
      "gemini": { input: 0.075, output: 0.30 },
      "azure-openai": { input: 0.10, output: 0.40 },
      "openai": { input: 2.50, output: 10.00 },
      "anthropic": { input: 3.00, output: 15.00 },
    };
    const p = pricing[this.config.provider] || pricing["gemini"];
    return (this.usage.promptTokens / 1_000_000) * p.input + (this.usage.completionTokens / 1_000_000) * p.output;
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

// ── Deprecated global state wrappers (for backward compatibility) ──

/** @deprecated Use LLMClient class instead */
let _globalClient: LLMClient | null = null;

/** @deprecated Use `new LLMClient(config)` instead */
export function setLLMConfig(config: LLMConfig): void {
  _globalClient = new LLMClient(config);
}

/** @deprecated Use LLMClient instance methods instead */
export function getUsageStats(): UsageStats {
  if (!_globalClient) return { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return _globalClient.getUsageStats();
}

/** @deprecated Use LLMClient instance methods instead */
export function resetUsageStats(): void {
  if (_globalClient) _globalClient.resetUsageStats();
}

/** @deprecated Use LLMClient instance methods instead */
export function getEstimatedCost(): number {
  if (!_globalClient) return 0;
  return _globalClient.getEstimatedCost();
}

/** @deprecated Use LLMClient instance methods instead */
export function printUsageSummary(): void {
  if (_globalClient) _globalClient.printUsageSummary();
}

/** @deprecated Use LLMClient instance methods instead */
export async function chatComplete(
  system: string,
  userMessage: string,
  maxTokens = 8192
): Promise<string> {
  if (!_globalClient) throw new Error("LLM config not set. Call setLLMConfig() first.");
  return _globalClient.chatComplete(system, userMessage, maxTokens);
}
