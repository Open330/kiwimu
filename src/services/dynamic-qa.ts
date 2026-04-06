import { Store } from "../store";
import { LLMClient } from "../llm-client";
import { loadConfig, getActivePersona, type Persona, type LLMConfig } from "../config";
import { slugify } from "../pipeline/chunker";

export interface DynamicQAResult {
  pageId: number;
  slug: string;
  title: string;
  content: string;
  isPromotable: boolean;
  suggestedTitle: string;
  keyConcepts: string[];
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
{"title": "Short concept title", "content": "Full markdown content with [[wiki links]]", "isPromotable": true, "keyConcepts": ["concept1", "concept2"]}

- "isPromotable": true if the answer has enough educational substance (2+ paragraphs, definitions, examples) to be a standalone wiki page, false if it's just a brief clarification
- "keyConcepts": array of 1-5 key concept terms mentioned in the answer`;

  // 3. Call LLM
  const raw = await llmClient.chatComplete(systemPrompt, userPrompt, 4096);

  // 4. Parse response — robust JSON extraction with multiple fallbacks
  let parsed: { title: string; content: string; isPromotable?: boolean; keyConcepts?: string[] };
  try {
    // Remove markdown code fences if present
    let cleaned = raw.replace(/^```json?\n?/m, "").replace(/\n?```\s*$/m, "").trim();

    // Try to extract JSON object from response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");

    let jsonStr = jsonMatch[0];
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Try repairs for truncated JSON
      // Close unclosed strings
      const lastQuote = jsonStr.lastIndexOf('"');
      const afterQuote = jsonStr.slice(lastQuote + 1);
      if (afterQuote.indexOf('"') === -1 && afterQuote.length > 0) {
        jsonStr = jsonStr.slice(0, jsonStr.lastIndexOf('",') + 2) + '}';
      }
      // Balance braces
      const openBraces = (jsonStr.match(/\{/g) || []).length;
      const closeBraces = (jsonStr.match(/\}/g) || []).length;
      for (let i = 0; i < openBraces - closeBraces; i++) jsonStr += "}";
      parsed = JSON.parse(jsonStr);
    }

    // Ensure content is not JSON-encoded (sometimes LLM double-encodes)
    if (parsed.content && parsed.content.startsWith('{')) {
      try {
        const inner = JSON.parse(parsed.content);
        if (inner.content) parsed.content = inner.content;
      } catch { /* not double-encoded, use as-is */ }
    }
  } catch {
    // Fallback: treat the entire raw response as markdown content
    // Strip any JSON artifacts from the beginning
    let fallbackContent = raw
      .replace(/^```json?\n?/m, "").replace(/\n?```\s*$/m, "")
      .replace(/^\s*\{\s*"title"\s*:\s*"[^"]*"\s*,\s*"content"\s*:\s*"?/m, "")
      .replace(/"\s*\}\s*$/m, "")
      .trim();

    // If it still looks like JSON, try one more parse
    if (fallbackContent.startsWith('{')) {
      try {
        const lastTry = JSON.parse(fallbackContent);
        if (lastTry.content) fallbackContent = lastTry.content;
      } catch { /* use as-is */ }
    }

    parsed = {
      title: userQuestion.slice(0, 50),
      content: fallbackContent || raw
    };
  }

  // Unescape JSON string escapes that might remain in content
  if (parsed.content) {
    parsed.content = parsed.content
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
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

  // Determine promotability: content should be substantial (2+ paragraphs, 200+ chars)
  const isPromotable = parsed.isPromotable !== undefined
    ? parsed.isPromotable
    : parsed.content.length >= 200 && (parsed.content.match(/\n\n/g) || []).length >= 1;

  const keyConcepts = Array.isArray(parsed.keyConcepts) ? parsed.keyConcepts.filter(c => typeof c === 'string') : [];

  return {
    pageId,
    slug: finalSlug,
    title: parsed.title,
    content: parsed.content,
    isPromotable,
    suggestedTitle: parsed.title,
    keyConcepts,
  };
}
