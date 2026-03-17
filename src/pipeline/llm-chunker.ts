import { chatComplete } from "../llm-client";
import type { Store } from "../store";
import { slugify } from "./chunker";
import type { Persona } from "../config";

// ── Phase 1: Extract original document structure ──

const STRUCTURE_SYSTEM = `You are a document analyzer. Extract the chapter/section structure from this textbook content, preserving the original order and hierarchy.

Return valid JSON only. No markdown fences.`;

const STRUCTURE_PROMPT = `Extract the document structure from this text. Preserve the original chapter/section ordering.

Source: "{sourceTitle}"

TEXT:
---
{text}
---

Return a JSON array of sections in order. Each element:
- "title": string — Original section/chapter title from the document
- "content": string — The full content of this section, converted to clean markdown. Preserve all information. Use LaTeX ($..$ inline, $$...$$ display) for equations. Clean up OCR artifacts.
- "level": number — 1 for chapter, 2 for section, 3 for subsection

Keep the content faithful to the original. Do not add or remove information. Just clean up formatting.
Return at most 8 sections per response to keep output manageable.`;

// ── Phase 2: Extract concepts for separate pages ──

function getConceptSystem(persona: Persona | null): string {
  const base = `You are a study wiki editor. Given source material pages, identify important concepts, terms, and definitions that deserve their own dedicated wiki pages.

Rules:
- Pick terms that appear across multiple sections OR are fundamental domain concepts
- Each concept page should have substantial educational content (2+ paragraphs)
- Explain the concept clearly with definitions, formulas, examples, and context
- Use [[wiki links]] to reference other concepts and source pages. Example: "[[Synchrotron Radiation]] is observed at [[radio frequencies]]"
- Suggest Wikipedia links for further reading

Return valid JSON only. No markdown fences.`;

  if (persona) {
    return `${persona.system_prompt}\n\n${base}\n\nIMPORTANT: ${persona.content_style}`;
  }
  return base;
}

function getConceptPrompt(persona: Persona | null): string {
  const styleNote = persona
    ? `\n\nWrite content in the following style:\n${persona.content_style}`
    : "";

  return `Based on these source pages, create concept/glossary wiki pages for important terms.

Source pages already created:
{sourcePages}

Create 3-6 concept pages for the most important terms, definitions, laws, and equations found in these pages.
Do NOT duplicate the source pages — instead, create focused concept pages that the source pages can link to.
Keep each page concise (2-3 paragraphs).${styleNote}

Return a JSON array where each element has:
- "title": string — Short concept name, 1-3 words (e.g., "Synchrotron Radiation", "Flux Density", "Angular Resolution"). Keep titles short so they match naturally in text.
- "content": string — Educational markdown content with [[wiki links]] to other concepts and source pages
- "suggested_links": Array<{text: string, url: string}> — Wikipedia/external reference links`;
}

function getStructureSystem(persona: Persona | null): string {
  const base = `You are a document analyzer. Extract the chapter/section structure from this textbook content, preserving the original order and hierarchy.

Return valid JSON only. No markdown fences.`;

  if (persona) {
    return `${persona.system_prompt}\n\n${base}\n\nWhen converting content to markdown, apply this writing style:\n${persona.content_style}`;
  }
  return base;
}

interface StructurePage {
  title: string;
  content: string;
  level: number;
}

interface ConceptPage {
  title: string;
  content: string;
  suggested_links?: Array<{ text: string; url: string }>;
}

function splitByChapters(text: string): Array<{ chapterHint: string; text: string }> {
  const chapterPattern = /\n(?=(?:CHAPTER\s*\d+|Chapter\s+\d+)[A-Z\s])/g;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = chapterPattern.exec(text))) positions.push(m.index);

  if (positions.length < 2) return splitBySize(text, 20000);

  const chunks: Array<{ chapterHint: string; text: string }> = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : text.length;
    const chunkText = text.slice(start, end);
    const titleMatch = chunkText.match(/(?:CHAPTER\s*\d+|Chapter\s+\d+)\s*([^\n]+)/);
    const hint = titleMatch ? titleMatch[0].trim() : `Section ${i + 1}`;

    if (chunkText.length > 60000) {
      const sub = splitBySize(chunkText, 20000);
      sub.forEach((s, j) => chunks.push({ chapterHint: `${hint} (part ${j + 1}/${sub.length})`, text: s.text }));
    } else {
      chunks.push({ chapterHint: hint, text: chunkText });
    }
  }
  return chunks;
}

function splitBySize(text: string, maxSize: number): Array<{ chapterHint: string; text: string }> {
  const chunks: Array<{ chapterHint: string; text: string }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxSize, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf("\n\n", end);
      if (lastBreak > start + maxSize * 0.5) end = lastBreak;
    }
    chunks.push({ chapterHint: `Part ${chunks.length + 1}`, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

function parseJSON<T>(raw: string): T {
  let cleaned = raw.replace(/^```json?\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    // Try various repairs for truncated JSON
    const repairs = [
      // Truncated in the middle of a string value
      () => cleaned.replace(/,"[^"]*$/, "") + "}]",
      // Truncated after a value
      () => cleaned.replace(/,?\s*$/, "]"),
      // Truncated mid-object
      () => cleaned.replace(/,?\s*"[^"]*$/, "") + "}]",
      // Add missing closing brackets
      () => {
        const opens = (cleaned.match(/\[/g) || []).length;
        const closes = (cleaned.match(/\]/g) || []).length;
        const openBraces = (cleaned.match(/\{/g) || []).length;
        const closeBraces = (cleaned.match(/\}/g) || []).length;
        let fixed = cleaned;
        // Close any unclosed strings
        const lastQuote = fixed.lastIndexOf('"');
        const afterQuote = fixed.slice(lastQuote + 1);
        if (afterQuote.indexOf('"') === -1 && afterQuote.length > 0) {
          // We're inside an unclosed string, truncate to last complete field
          fixed = fixed.slice(0, fixed.lastIndexOf('",') + 2);
        }
        for (let i = 0; i < openBraces - closeBraces; i++) fixed += "}";
        for (let i = 0; i < opens - closes; i++) fixed += "]";
        return fixed;
      },
    ];
    for (const repair of repairs) {
      try {
        return JSON.parse(repair());
      } catch {}
    }
    // Last resort: log the problematic content for debugging
    console.log(`    \x1b[33m⚠ JSON repair 실패, 첫 200자: ${cleaned.slice(0, 200)}\x1b[0m`);
    throw e1;
  }
}

/**
 * Resolve [[wiki links]] in content to actual markdown links.
 */
function resolveWikiLinks(
  pageId: number,
  content: string,
  slugMap: Map<string, { id: number; slug: string }>,
  store: Store
): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_match, term: string) => {
    const slug = slugify(term);
    const target = slugMap.get(slug);
    if (target && target.id !== pageId) {
      store.addLink(pageId, target.id, term);
      return `[${term}](/wiki/${target.slug})`;
    }
    return term;
  });
}

export async function llmChunkDocument(
  rawText: string,
  sourceTitle: string,
  sourceId: number,
  store: Store,
  maxChunks: number = 0, // 0 = unlimited
  persona: Persona | null = null
): Promise<{ sourceCount: number; conceptCount: number }> {
  let chunks = splitByChapters(rawText);
  if (maxChunks > 0 && chunks.length > maxChunks) {
    console.log(`\x1b[33m⚠ ${chunks.length}개 청크 중 ${maxChunks}개만 처리합니다\x1b[0m`);
    chunks = chunks.slice(0, maxChunks);
  }
  if (persona) {
    console.log(`\x1b[35m🎭 페르소나: ${persona.name}\x1b[0m`);
  }
  console.log(`\x1b[34m🧠 Phase 1: 원본 구조 추출 (${chunks.length}개 청크)...\x1b[0m`);

  // ── Phase 1: Extract source pages ──
  let orderCounter = 0;
  const sourcePageSummaries: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  [${i + 1}/${chunks.length}] ${chunk.chapterHint}`);

    const prompt = STRUCTURE_PROMPT
      .replace("{sourceTitle}", sourceTitle)
      .replace("{text}", chunk.text.slice(0, 80000));

    const structureSystem = getStructureSystem(persona);
    try {
      const raw = await chatComplete(structureSystem, prompt, 16384);
      if (!raw || raw.trim().length < 10) {
        console.log(`    \x1b[33m⚠ 빈 응답, 재시도...\x1b[0m`);
        const retry = await chatComplete(structureSystem, prompt, 16384);
        if (!retry || retry.trim().length < 10) {
          console.log(`    \x1b[31m✗ 재시도도 빈 응답\x1b[0m`);
          continue;
        }
        const sections = parseJSON<StructurePage[]>(retry).filter(s => s.title && s.content && s.content.length > 30);
        // fall through to process sections below
        for (const section of sections) {
          const slug = slugify(section.title);
          if (!slug) continue;
          const existing = store.getPage(slug);
          if (existing) {
            store.updatePageContent(existing.id, existing.content + "\n\n" + section.content);
          } else {
            store.addPage(slug, section.title, section.content, sourceId, slug, "source", orderCounter++);
            sourcePageSummaries.push(`- ${section.title}: ${section.content.slice(0, 150).replace(/\n/g, " ")}`);
          }
        }
        console.log(`    → ${sections.length}개 섹션`);
        continue;
      }
      const sections = parseJSON<StructurePage[]>(raw).filter(s => s.title && s.content && s.content.length > 30);

      for (const section of sections) {
        const slug = slugify(section.title);
        if (!slug) continue;

        const existing = store.getPage(slug);
        if (existing) {
          store.updatePageContent(existing.id, existing.content + "\n\n" + section.content);
        } else {
          store.addPage(slug, section.title, section.content, sourceId, slug, "source", orderCounter++);
          sourcePageSummaries.push(`- ${section.title}: ${section.content.slice(0, 150).replace(/\n/g, " ")}`);
        }
      }
      console.log(`    → ${sections.length}개 섹션`);
    } catch (e: any) {
      console.log(`    \x1b[31m✗ 실패: ${e.message}\x1b[0m`);
    }
  }

  const sourceCount = orderCounter;
  console.log(`\x1b[32m  📖 ${sourceCount}개 원본 페이지 생성 완료\x1b[0m`);

  // ── Phase 2: Extract concept pages ──
  console.log(`\x1b[34m🧠 Phase 2: 개념 페이지 추출...\x1b[0m`);

  // Process source pages in small batches for concept extraction
  const batchSize = 5;
  let conceptCount = 0;

  for (let i = 0; i < sourcePageSummaries.length; i += batchSize) {
    const batch = sourcePageSummaries.slice(i, i + batchSize);
    const batchLabel = `  [${Math.floor(i / batchSize) + 1}/${Math.ceil(sourcePageSummaries.length / batchSize)}]`;
    console.log(`${batchLabel} 개념 추출 중...`);

    const existingConcepts = conceptCount > 0
      ? `\n\nAlready created concept pages (do not duplicate): ${store.listConceptPages().map(p => p.title).join(", ")}`
      : "";
    const conceptPrompt = getConceptPrompt(persona);
    const prompt = conceptPrompt.replace("{sourcePages}", batch.join("\n")) + existingConcepts;
    const conceptSystem = getConceptSystem(persona);

    try {
      const raw = await chatComplete(conceptSystem, prompt, 16384);
      const concepts = parseJSON<ConceptPage[]>(raw).filter(c => c.title && c.content && c.content.length > 50);

      for (const concept of concepts) {
        const slug = slugify(concept.title);
        if (!slug) continue;

        // Don't create concept page if source page with same slug exists
        const existing = store.getPage(slug);
        if (existing) continue;

        let content = concept.content;
        if (concept.suggested_links?.length) {
          content += "\n\n## External References\n\n";
          for (const link of concept.suggested_links) {
            content += `- [${link.text}](${link.url})\n`;
          }
        }

        store.addPage(slug, concept.title, content, sourceId, slug, "concept", 0);
        conceptCount++;
      }
      console.log(`    → ${concepts.length}개 개념`);
    } catch (e: any) {
      console.log(`    \x1b[31m✗ 실패: ${e.message}\x1b[0m`);
    }
  }

  console.log(`\x1b[32m  📝 ${conceptCount}개 개념 페이지 생성 완료\x1b[0m`);

  // ── Phase 3: Resolve wiki links + inject concept links into source pages ──
  console.log(`\x1b[34m🔗 위키 링크 해석 중...\x1b[0m`);
  const allPages = store.listPages();
  const slugMap = new Map(allPages.map(p => [p.slug, { id: p.id, slug: p.slug }]));
  for (const p of allPages) {
    const titleSlug = slugify(p.title);
    if (!slugMap.has(titleSlug)) slugMap.set(titleSlug, { id: p.id, slug: p.slug });
  }

  // Resolve [[wiki links]] in concept pages
  let linkedPages = 0;
  for (const page of allPages) {
    if (!page.content.includes("[[")) continue;
    const resolved = resolveWikiLinks(page.id, page.content, slugMap, store);
    if (resolved !== page.content) {
      store.updatePageContent(page.id, resolved);
      linkedPages++;
    }
  }

  // Inject concept links into source pages
  const conceptPages = allPages.filter(p => p.page_type === "concept");
  const srcPages = allPages.filter(p => p.page_type === "source");

  // Build search terms: full title + key words from title (2+ words long)
  const searchTerms: Array<{ term: string; concept: typeof conceptPages[0] }> = [];
  for (const concept of conceptPages) {
    searchTerms.push({ term: concept.title, concept });
    // Also try individual significant words from multi-word titles
    const words = concept.title.split(/\s+/).filter(w => w.length >= 4 && !/^(and|the|for|with|from|into)$/i.test(w));
    if (words.length >= 2) {
      // Try pairs of consecutive words
      for (let i = 0; i < words.length - 1; i++) {
        searchTerms.push({ term: `${words[i]} ${words[i + 1]}`, concept });
      }
    }
  }
  // Sort by term length descending for longest match first
  searchTerms.sort((a, b) => b.term.length - a.term.length);

  for (const srcPage of srcPages) {
    let content = srcPage.content;
    let modified = false;
    const linkedConcepts = new Set<number>();

    for (const { term, concept } of searchTerms) {
      if (linkedConcepts.has(concept.id)) continue; // One link per concept per page
      if (term.length < 3) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(?<!\\[)(?<![\\w/])(${escaped})(?![\\w])(?!\\])(?![^[]*\\])`, "i");
      const match = regex.exec(content);
      if (match) {
        const replacement = `[${match[1]}](/wiki/${concept.slug})`;
        content = content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);
        store.addLink(srcPage.id, concept.id, match[1]);
        linkedConcepts.add(concept.id);
        modified = true;
      }
    }
    if (modified) {
      store.updatePageContent(srcPage.id, content);
      linkedPages++;
    }
  }

  console.log(`\x1b[32m  ${linkedPages}개 페이지에서 위키 링크 해석 완료\x1b[0m`);

  return { sourceCount, conceptCount };
}

export function htmlToRawText(html: string): string {
  const { load } = require("cheerio");
  const $ = load(html);
  $("script, style, nav, header, footer, noscript").remove();
  return $("body").text() || $.text();
}
