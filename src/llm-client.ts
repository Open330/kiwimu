import type { LLMConfig } from "./config";

// Token usage tracking
export interface UsageStats {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const _usage: UsageStats = {
  totalCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

let _llmConfig: LLMConfig | null = null;

export function setLLMConfig(config: LLMConfig): void {
  _llmConfig = config;
}

export function getLLMConfig(): LLMConfig {
  if (!_llmConfig) throw new Error("LLM config not set. Call setLLMConfig() first.");
  return _llmConfig;
}

export function getUsageStats(): UsageStats {
  return { ..._usage };
}

export function resetUsageStats(): void {
  _usage.totalCalls = 0;
  _usage.promptTokens = 0;
  _usage.completionTokens = 0;
  _usage.totalTokens = 0;
}

export function getEstimatedCost(): number {
  const config = _llmConfig;
  if (!config) return 0;

  // Pricing per 1M tokens (approximate)
  const pricing: Record<string, { input: number; output: number }> = {
    "gemini": { input: 0.075, output: 0.30 },
    "azure-openai": { input: 0.10, output: 0.40 },
    "openai": { input: 0.15, output: 0.60 },
    "anthropic": { input: 3.00, output: 15.00 },
  };
  const p = pricing[config.provider] || pricing["gemini"];
  return (_usage.promptTokens / 1_000_000) * p.input + (_usage.completionTokens / 1_000_000) * p.output;
}

export function printUsageSummary(): void {
  const u = _usage;
  const cost = getEstimatedCost();
  const provider = _llmConfig?.provider || "unknown";
  const model = _llmConfig?.model || "unknown";

  console.log(`\x1b[34m📊 LLM 사용량 (${provider}/${model}):\x1b[0m`);
  console.log(`  호출 횟수:     ${u.totalCalls}회`);
  console.log(`  입력 토큰:     ${u.promptTokens.toLocaleString()}`);
  console.log(`  출력 토큰:     ${u.completionTokens.toLocaleString()}`);
  console.log(`  총 토큰:       ${u.totalTokens.toLocaleString()}`);
  console.log(`  예상 비용:     ~$${cost.toFixed(4)}`);
}

// ── Provider implementations ──

async function geminiComplete(system: string, userMessage: string, maxTokens: number): Promise<{ text: string; usage?: any }> {
  const config = getLLMConfig();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.api_key}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const usage = data.usageMetadata;
  return {
    text,
    usage: usage ? {
      prompt_tokens: usage.promptTokenCount || 0,
      completion_tokens: usage.candidatesTokenCount || 0,
      total_tokens: usage.totalTokenCount || 0,
    } : undefined,
  };
}

async function azureOpenAIComplete(system: string, userMessage: string, maxTokens: number): Promise<{ text: string; usage?: any }> {
  const config = getLLMConfig();

  // Try loading from ~/keys/openai.azure.com/ if no api_key in config
  let apiKey = config.api_key;
  let endpoint = config.endpoint;
  let model = config.model;

  if (!apiKey) {
    try {
      const keyFile = `${process.env.HOME}/keys/openai.azure.com/${config.model}.json`;
      const raw = require("fs").readFileSync(keyFile, "utf-8");
      const keyConfig = JSON.parse(raw)[0];
      apiKey = keyConfig.key;
      endpoint = keyConfig.endpoint.split("/openai/")[0];
      model = keyConfig.deployment;
    } catch {
      throw new Error("Azure OpenAI API key not configured");
    }
  }

  const { AzureOpenAI } = await import("openai");
  const client = new AzureOpenAI({ endpoint, apiKey, deployment: model, apiVersion: "2024-12-01-preview" });

  const resp = await client.chat.completions.create({
    model,
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

// ── Main interface ──

export async function chatComplete(
  system: string,
  userMessage: string,
  maxTokens = 8192
): Promise<string> {
  const config = getLLMConfig();

  let result: { text: string; usage?: any };

  switch (config.provider) {
    case "gemini":
      result = await geminiComplete(system, userMessage, maxTokens);
      break;
    case "azure-openai":
      result = await azureOpenAIComplete(system, userMessage, maxTokens);
      break;
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }

  // Track usage
  if (result.usage) {
    _usage.totalCalls++;
    _usage.promptTokens += result.usage.prompt_tokens || 0;
    _usage.completionTokens += result.usage.completion_tokens || 0;
    _usage.totalTokens += result.usage.total_tokens || 0;
  }

  return result.text;
}
