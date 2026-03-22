import type { Page } from "../store";
import type { Persona } from "../config";

function buildPrompt(page: Page, context: Page[], persona: Persona | null = null): string {
  const styleInstruction = persona
    ? `\n\nIMPORTANT STYLE GUIDE:\n${persona.system_prompt}\n\n${persona.content_style}`
    : "";

  const prompt = `You are a wiki editor for a learning platform. Given a wiki page about a topic,
expand it with more detail, examples, and related concepts. Keep the markdown format.
Add subsections where appropriate. Be accurate and educational.${styleInstruction}

Current page title: {title}
Current content:
{content}

Related pages for context:
{context}

Write an expanded version of this page in markdown:`;

  return prompt.replace("{title}", page.title)
    .replace("{content}", page.content)
    .replace("{context}", context.slice(0, 10).map((p) => `- ${p.title}`).join("\n"));
}

export async function expandWithApi(page: Page, context: Page[], provider: string, model?: string): Promise<string> {
  const prompt = buildPrompt(page, context);

  if (provider === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: model || "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    return (resp.content[0] as { type: string; text: string }).text;
  }

  if (provider === "openai") {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI();
    const resp = await client.chat.completions.create({
      model: model || "gpt-5.4",
      messages: [{ role: "user", content: prompt }],
    });
    return resp.choices[0].message.content || "";
  }

  throw new Error(`Unknown provider: ${provider}`);
}

export async function expandWithCli(page: Page, context: Page[], tool: string): Promise<string> {
  const prompt = buildPrompt(page, context);
  const cmd = tool === "claude" ? ["claude", "-p", prompt] : ["codex", "--quiet", "--prompt", prompt];

  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${tool} failed: ${stderr}`);
  }

  return output;
}
