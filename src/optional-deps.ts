/**
 * openai / @anthropic-ai/sdk are optionalDependencies: installs with
 * `--no-optional` (or a failed optional install) won't have them. Wrap the
 * dynamic imports so users get an actionable message instead of a raw
 * "Cannot find module".
 */

export async function importOpenAI(): Promise<typeof import("openai")> {
  try {
    return await import("openai");
  } catch {
    throw new Error(
      "'openai' 패키지가 설치되어 있지 않습니다. `bun add openai` 후 다시 시도하세요. (openai/azure-openai provider에 필요)",
    );
  }
}

export async function importAnthropic(): Promise<typeof import("@anthropic-ai/sdk")> {
  try {
    return await import("@anthropic-ai/sdk");
  } catch {
    throw new Error(
      "'@anthropic-ai/sdk' 패키지가 설치되어 있지 않습니다. `bun add @anthropic-ai/sdk` 후 다시 시도하세요. (anthropic provider에 필요)",
    );
  }
}
