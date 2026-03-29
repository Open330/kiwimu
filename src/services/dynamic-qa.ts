import { Store } from "../store";
import { LLMClient } from "../llm-client";
import { loadConfig, getActivePersona, type Persona, type LLMConfig } from "../config";
import { slugify } from "../pipeline/chunker";

export interface DynamicQAResult {
  pageId: number;
  slug: string;
  title: string;
  content: string;
}

export async function generateDynamicPage(
  store: Store,
  llmClient: LLMClient,
  persona: Persona | null,
  parentPage: { id: number; slug: string; title: string; content: string },
  selectedText: string,
  userQuestion: string
): Promise<DynamicQAResult> {
  // 1. Build context hierarchy
  // L1: selectedText (truncate to 2000 chars)
  // L2: parentPage.content
  // L3: related pages (backlinks + forward links, title + first 300 chars)
  // L4: all concept titles

  const backlinks = store.getBacklinks(parentPage.id);
  const allLinks = store.getForwardLinks(parentPage.id);

  const relatedSummaries = [...backlinks, ...allLinks]
    .map(p => `- ${p.title}: ${(p as any).content?.slice(0, 300) || ''}`)
    .slice(0, 10)
    .join('\n');

  const conceptTitles = store.listConceptPages()
    .slice(0, 50)
    .map(p => p.title)
    .join(', ');

  // 2. Build system prompt
  const personaStyle = persona ? `\n\nStyle: ${persona.content_style || persona.system_prompt || ''}` : '';

  const systemPrompt = `You are a study wiki editor. A student is reading a wiki page and has selected some text. They have a follow-up question about it. Your job is to create a new, self-contained concept page that answers their question thoroughly.

Rules:
- Create a focused wiki page (2-4 paragraphs) that answers the question
- Use [[wiki links]] to reference existing concepts where relevant
- Include examples, formulas (LaTeX $..$ / $$...$$), and definitions as appropriate
- The page should be educational and self-contained
- Return valid JSON only${personaStyle}`;

  const userPrompt = `## Student's Question
${userQuestion}

## Selected Text
${selectedText.slice(0, 2000)}

## Current Page: ${parentPage.title}
${parentPage.content.slice(0, 5000)}

## Related Pages
${relatedSummaries || '(none)'}

## All Wiki Concepts
${conceptTitles || '(none)'}

Return a JSON object:
{"title": "Short concept title", "content": "Full markdown content with [[wiki links]]"}`;

  // 3. Call LLM
  const raw = await llmClient.chatComplete(systemPrompt, userPrompt, 4096);

  // 4. Parse response - reuse parseJSON pattern
  let parsed: { title: string; content: string };
  try {
    // Try to extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // Fallback: use the raw response as content
    parsed = { title: userQuestion.slice(0, 50), content: raw };
  }

  if (!parsed.title || !parsed.content || parsed.content.length < 20) {
    throw new Error("LLM 응답이 불충분합니다. 다시 시도해주세요.");
  }

  // 5. Generate slug, handle collision
  let slug = slugify(parsed.title);
  if (!slug) slug = slugify(userQuestion);
  if (!slug) slug = `dynamic-${Date.now()}`;

  let finalSlug = slug;
  let counter = 2;
  while (store.getPage(finalSlug)) {
    finalSlug = `${slug}-${counter++}`;
  }

  // 6. Store the page
  const pageId = store.addDynamicPage(finalSlug, parsed.title, parsed.content, parentPage.id, userQuestion);

  // 7. Add link from parent to new page
  store.addLink(parentPage.id, pageId, parsed.title);

  // 8. Log usage
  const usage = llmClient.getUsageStats();
  const estimatedCostUsd = llmClient.getEstimatedCost();
  store.addUsageLog(null, usage.totalCalls, usage.promptTokens, usage.completionTokens, usage.totalTokens, estimatedCostUsd);

  return { pageId, slug: finalSlug, title: parsed.title, content: parsed.content };
}
