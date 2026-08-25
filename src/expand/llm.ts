import { importAnthropic, importOpenAI } from "../optional-deps";
import type { Page } from "../store";
import type { Persona, WikiSchema } from "../config";
import { resolvePageSections, resolveMinPageLength } from "../config";

function buildPrompt(
  page: Page,
  context: Page[],
  persona: Persona | null = null,
  schema?: WikiSchema,
): string {
  const styleInstruction = persona
    ? `\n\nIMPORTANT STYLE GUIDE:\n${persona.system_prompt}\n\n${persona.content_style}`
    : "";

  const sections = resolvePageSections(schema);
  const minLength = resolveMinPageLength(schema);

  // Give the model the actual surrounding material (excerpts), not just titles,
  // so the expansion is grounded and can cross-link related concepts.
  const contextBlock = context
    .slice(0, 8)
    .map((p) => `### ${p.title}\n${p.content.slice(0, 400).replace(/\s+/g, " ").trim()}`)
    .join("\n\n");

  const prompt = `You are a wiki editor for a learning platform. Given a wiki page about a topic,
expand it into a thorough, structured page with more detail, examples, and related concepts. Keep the markdown format.
Organize the body with these sections using ## headings where they fit: ${sections.join(", ")}.
Write at least ${minLength} characters of substantial content and use [[wiki links]] to connect related concepts.
Preserve all existing information, links, equations, and citations. Add subsections where appropriate. Be accurate and educational.${styleInstruction}

Current page title: {title}
Current content:
{content}

Related pages for context (excerpts):
{context}

Write an expanded version of this page in markdown:`;

  return prompt
    .replace("{title}", () => page.title)
    .replace("{content}", () => page.content)
    .replace("{context}", () => contextBlock);
}

export async function expandWithApi(
  page: Page,
  context: Page[],
  provider: string,
  model?: string,
  apiKey?: string,
  persona: Persona | null = null,
  schema?: WikiSchema,
): Promise<string> {
  const prompt = buildPrompt(page, context, persona, schema);

  if (provider === "anthropic") {
    const { default: Anthropic } = await importAnthropic();
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: model || "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    return (resp.content[0] as { type: string; text: string }).text;
  }

  if (provider === "openai") {
    const { default: OpenAI } = await importOpenAI();
    const client = new OpenAI({ apiKey });
    const resp = await client.chat.completions.create({
      model: model || "gpt-5.4",
      messages: [{ role: "user", content: prompt }],
    });
    return resp.choices[0].message.content || "";
  }

  throw new Error(`Unknown provider: ${provider}`);
}

export async function expandWithCli(
  page: Page,
  context: Page[],
  tool: string,
  persona: Persona | null = null,
  schema?: WikiSchema,
): Promise<string> {
  const prompt = buildPrompt(page, context, persona, schema);
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
