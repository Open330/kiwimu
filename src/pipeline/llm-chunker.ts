import { createHash } from "node:crypto";
import { LLMClient } from "../llm-client";
import type { Store } from "../store";
import { slugify } from "./chunker";
import type { Persona, WikiSchema } from "../config";
import { compileTerms, standardizeTerms } from "./standardizer";
import { parseCitations } from "./citations";
import { replaceWikiLinkMarkers } from "./markdown-segments";
import { stripJsonFences } from "../utils";

// ── Phase 1: Extract original document structure ──

const STRUCTURE_PROMPT = `Extract the document structure from this text. Preserve the original chapter/section ordering.

Source: "{sourceTitle}"

TEXT:
---
{text}
---

Return a JSON array of sections in order. Each element:
- "title": string — Original section/chapter title from the document
- "content": string — The full content of this section, converted to clean markdown. Preserve all information. Use LaTeX ($..$ inline, $$...$$ display) for equations. Clean up OCR artifacts. When the content describes processes, workflows, hierarchies, state transitions, or relationships, add a Mermaid diagram using fenced code blocks (\`\`\`mermaid). Supported types: flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, pie, mindmap, timeline.
- "level": number — 1 for chapter, 2 for section, 3 for subsection

Keep the content faithful to the original. Do not add or remove information. Just clean up formatting.
When appropriate, enhance understanding by including Mermaid diagrams that visualize key concepts, flows, or relationships described in the text.
Return at most 8 sections per response to keep output manageable.`;

// ── Phase 2: Extract concepts for separate pages ──

function getConceptSystem(persona: Persona | null, schema?: WikiSchema): string {
  const base = `You are a study wiki editor. Given source material pages, identify important concepts, terms, and definitions that deserve their own dedicated wiki pages.

Rules:
- Pick terms that appear across multiple sections OR are fundamental domain concepts
- Each concept page should have substantial educational content (2+ paragraphs)
- Explain the concept clearly with definitions, formulas, examples, and context
- Use [[wiki links]] to reference other concepts and source pages. Example: "[[Synchrotron Radiation]] is observed at [[radio frequencies]]"
- Use LaTeX ($..$ inline, $$...$$ display) for equations
- When a concept involves processes, relationships, hierarchies, or state transitions, include a Mermaid diagram using fenced code blocks (\`\`\`mermaid). Supported: flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, mindmap, pie
- Suggest Wikipedia links for further reading

Return valid JSON only. No markdown fences.`;

  let schemaRules = "";
  if (schema) {
    const rules: string[] = [];
    if (schema.categories?.length) {
      rules.push(`- Assign each concept to one of these categories: ${schema.categories.join(", ")}. Include a "category" field in your JSON output.`);
    }
    if (schema.page_template?.sections?.length) {
      rules.push(`- Structure each concept page with these sections (use ## headings): ${schema.page_template.sections.join(", ")}`);
    }
    if (schema.naming_convention) {
      const conventions: Record<string, string> = {
        noun_phrase: "Use noun phrases for titles (e.g., 'Neural Network', 'Gradient Descent')",
        question: "Use question form for titles (e.g., 'What is a Neural Network?', 'How does Gradient Descent work?')",
        topic: "Use simple topic words for titles (e.g., 'Backpropagation', 'Optimization')",
      };
      rules.push(`- Title format: ${conventions[schema.naming_convention] || schema.naming_convention}`);
    }
    if (schema.terms && Object.keys(schema.terms).length > 0) {
      const termList = Object.entries(schema.terms).map(([k, v]) => `${k} -> ${v}`).join(", ");
      rules.push(`- Use these standard terms (replace abbreviations with full forms): ${termList}`);
    }
    if (rules.length > 0) {
      schemaRules = `\n\nSchema rules:\n${rules.join("\n")}`;
    }
  }

  if (persona) {
    return `${persona.system_prompt}\n\n${base}${schemaRules}\n\nIMPORTANT: ${persona.content_style}`;
  }
  return `${base}${schemaRules}`;
}

function getConceptPrompt(persona: Persona | null, schema?: WikiSchema): string {
  const styleNote = persona
    ? `\n\nWrite content in the following style:\n${persona.content_style}`
    : "";

  const categoryField = schema?.categories?.length
    ? `\n- "category": string — One of: ${schema.categories.join(", ")}`
    : "";

  return `Based on these source pages, create concept/glossary wiki pages for important terms.

Source pages already created:
{sourcePages}

Create 3-6 concept pages for the most important terms, definitions, laws, and equations found in these pages.
Do NOT duplicate the source pages — instead, create focused concept pages that the source pages can link to.
Keep each page concise (2-3 paragraphs).${styleNote}

IMPORTANT — Provenance citations:
When a claim or fact comes from a specific source page, add an inline citation marker at the end of that sentence using the format [^src:SOURCE_PAGE_SLUG].
The SOURCE_PAGE_SLUG must match one of the source page slugs listed above (the hyphenated identifier shown after the title).
Example: "Quantum entanglement allows particles to share states instantly [^src:chapter-3-quantum-states]"
Only cite when a fact clearly originates from a specific source page. Not every sentence needs a citation.

Return a JSON array where each element has:
- "title": string — Short concept name, 1-3 words (e.g., "Synchrotron Radiation", "Flux Density", "Angular Resolution"). Keep titles short so they match naturally in text.
- "content": string — Educational markdown content with [[wiki links]] to other concepts and source pages, and [^src:slug] citations where appropriate${categoryField}
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
  category?: string;
  suggested_links?: Array<{ text: string; url: string }>;
}

interface QuizPage {
  question: string;
  answer: string;
  explanation?: string;
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStructureResponse(raw: string): StructurePage[] {
  const parsed = parseJSON<unknown>(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Phase 1 response must contain at least one section");
  }

  return parsed.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.title !== "string" || !value.title.trim() ||
      typeof value.content !== "string" || value.content.length <= 30 ||
      typeof value.level !== "number" || !Number.isFinite(value.level)
    ) {
      throw new Error(`Phase 1 section ${index + 1} is malformed`);
    }
    return { title: value.title, content: value.content, level: value.level };
  });
}

function parseConceptResponse(raw: string): ConceptPage[] {
  const parsed = parseJSON<unknown>(raw);
  if (!Array.isArray(parsed)) throw new Error("Phase 2 response must be an array");

  return parsed.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.title !== "string" || !value.title.trim() ||
      typeof value.content !== "string" || value.content.length <= 50 ||
      (value.category !== undefined && typeof value.category !== "string") ||
      (value.suggested_links !== undefined && (
        !Array.isArray(value.suggested_links) ||
        value.suggested_links.some(link =>
          !isRecord(link) || typeof link.text !== "string" || typeof link.url !== "string"
        )
      ))
    ) {
      throw new Error(`Phase 2 concept ${index + 1} is malformed`);
    }
    return value as unknown as ConceptPage;
  });
}

function parseQuizResponse(raw: string): QuizPage[] {
  const parsed = parseJSON<unknown>(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Quiz response must contain at least one quiz");
  }

  return parsed.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.question !== "string" || !value.question.trim() ||
      typeof value.answer !== "string" || !value.answer.trim() ||
      typeof value.type !== "string" || !value.type.trim() ||
      (value.explanation !== undefined && typeof value.explanation !== "string")
    ) {
      throw new Error(`Quiz ${index + 1} is malformed`);
    }
    return value as unknown as QuizPage;
  });
}

function appendSlugSuffix(base: string, suffix: string): string {
  const available = Math.max(1, 80 - Array.from(suffix).length);
  const prefix = Array.from(base).slice(0, available).join("").replace(/-+$/g, "");
  return `${prefix}${suffix}`;
}

/** Keep the first generated slug readable while isolating foreign/user collisions. */
function resolveGeneratedPageSlug(
  base: string,
  title: string,
  sourceId: number,
  pageType: "source" | "concept",
  store: Store,
): string {
  const belongsToSource = (slug: string): boolean => {
    const page = store.getPage(slug);
    return page?.page_type === pageType && page.source_id === sourceId && page.origin === "batch";
  };

  const existing = store.getPage(base);
  if (!existing || (belongsToSource(base) && existing.title === title)) return base;

  // Different generated titles can normalize to the same slug (for example,
  // C++ and C#). A title-derived suffix is stable across retries and resume,
  // unlike selecting whichever numeric slot happens to be free at the time.
  if (belongsToSource(base)) {
    const identity = createHash("sha256").update(title.normalize("NFC")).digest("hex").slice(0, 8);
    let counter = 1;
    while (true) {
      const suffix = counter === 1 ? `-${identity}` : `-${identity}-${counter}`;
      const candidate = appendSlugSuffix(base, suffix);
      const candidatePage = store.getPage(candidate);
      if (!candidatePage || (belongsToSource(candidate) && candidatePage.title === title)) {
        return candidate;
      }
      counter++;
    }
  }

  let counter = 1;
  while (true) {
    const suffix = counter === 1 ? `-source-${sourceId}` : `-source-${sourceId}-${counter}`;
    const candidate = appendSlugSuffix(base, suffix);
    const candidatePage = store.getPage(candidate);
    if (!candidatePage || (belongsToSource(candidate) && candidatePage.title === title)) return candidate;
    counter++;
  }
}

async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
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
  let cleaned = stripJsonFences(raw);
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
  return replaceWikiLinkMarkers(content, (marker) => {
    const slug = slugify(marker.slug);
    const target = slugMap.get(slug);
    if (target && target.id !== pageId) {
      const label = marker.display ?? marker.slug;
      store.addLink(pageId, target.id, label);
      return `[${label}](/wiki/${target.slug})`;
    }
    return marker.raw;
  });
}

export async function llmChunkDocument(
  rawText: string,
  sourceTitle: string,
  sourceId: number,
  store: Store,
  maxChunks: number = 0, // 0 = unlimited
  persona: Persona | null = null,
  llmClient: LLMClient,
  onProgress?: (status: string) => void,
  schema?: WikiSchema,
  incremental: boolean = false,
  checkpointInputHash?: string,
): Promise<{ sourceCount: number; conceptCount: number }> {
  const chat = (system: string, user: string, maxTokens?: number) =>
    llmClient.chatComplete(system, user, maxTokens);

  // Pre-compile term standardization regexes if schema.terms is defined
  const compiledTerms = schema?.terms && Object.keys(schema.terms).length > 0
    ? compileTerms(schema.terms)
    : null;

  let chunks = splitByChapters(rawText);
  if (maxChunks > 0 && chunks.length > maxChunks) {
    console.log(`\x1b[33m⚠ ${chunks.length}개 청크 중 ${maxChunks}개만 처리합니다\x1b[0m`);
    chunks = chunks.slice(0, maxChunks);
  }
  if (persona) {
    console.log(`\x1b[35m🎭 페르소나: ${persona.name}\x1b[0m`);
  }
  // ── Phase 1: Extract source pages (parallel LLM calls) ──
  let sourceCount: number;
  let sourcePageSummaries: string[];

  if (store.hasPhaseCheckpoint(sourceId, 'phase1')) {
    // Resume: Phase 1 already done, rebuild summaries from DB
    const existingPages = store.getSourcePages(sourceId)
      .filter(page => page.origin === "batch");
    sourceCount = existingPages.length;
    sourcePageSummaries = existingPages.map(p =>
      `- ${p.title} [slug: ${p.slug}]: ${p.content.slice(0, 150).replace(/\n/g, " ")}`
    );
    console.log(`\x1b[32m⏭ Phase 1 건너뜀 (이미 완료) — 📖 ${sourceCount}개 원본 페이지\x1b[0m`);
    onProgress?.(`Phase 1 건너뜀 (${sourceCount}개 페이지 이미 존재)`);
  } else {
    const phase1Start = performance.now();
    const structureSystem = getStructureSystem(persona);

    // Per-chunk resumability: skip chunks already committed in a prior run.
    const lastChunk = store.getLastCompletedBatch(sourceId, 'phase1_chunk'); // -1 if none
    const existingPages = store.getSourcePages(sourceId)
      .filter(page => page.origin === "batch");
    let orderCounter = existingPages.length;
    sourcePageSummaries = existingPages.map(p =>
      `- ${p.title} [slug: ${p.slug}]: ${p.content.slice(0, 150).replace(/\n/g, " ")}`
    );

    const remaining = chunks
      .map((chunk, ci) => ({ chunk, ci }))
      .filter(({ ci }) => ci > lastChunk);

    if (lastChunk >= 0) {
      console.log(`\x1b[34m⏳ Phase 1: 원본 구조 추출 재개 (청크 ${lastChunk + 2}/${chunks.length}부터)...\x1b[0m`);
      onProgress?.(`Phase 1: 청크 ${lastChunk + 2}/${chunks.length}부터 재개`);
    } else {
      console.log(`\x1b[34m⏳ Phase 1: 원본 구조 추출 중... (${chunks.length}개 청크)\x1b[0m`);
      onProgress?.(`Phase 1: 원본 구조 추출 중... (${chunks.length}개 청크)`);
    }

    let completedCount = lastChunk + 1;
    // Extract in parallel (LLM calls), but keep results in original chunk order.
    const chunkResults = await parallelMap(remaining, 3, async ({ chunk, ci }) => {
      console.log(`  Phase 1: 처리 중 [${ci + 1}/${chunks.length}] ${chunk.chapterHint}...`);

      const prompt = STRUCTURE_PROMPT
        .replace("{sourceTitle}", sourceTitle)
        .replace("{text}", chunk.text.slice(0, 80000));

      try {
        let raw = await chat(structureSystem, prompt, 16384);
        if (!raw || raw.trim().length < 10) {
          console.log(`    \x1b[33m⚠ 빈 응답, 재시도...\x1b[0m`);
          raw = await chat(structureSystem, prompt, 16384);
          if (!raw || raw.trim().length < 10) {
            throw new Error("Phase 1 returned an empty response twice");
          }
        }
        const sections = parseStructureResponse(raw);
        console.log(`    → ${sections.length}개 섹션`);
        return { ci, sections, error: null };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`    \x1b[31m✗ 실패: ${message}\x1b[0m`);
        return { ci, sections: [] as StructurePage[], error: e };
      }
    });

    // Store results sequentially in chunk order, checkpointing per chunk so a
    // crash resumes from the last fully-committed chunk.
    for (const { ci, sections, error } of chunkResults) {
      if (error !== null) {
        throw new Error(`Phase 1 chunk ${ci + 1}/${chunks.length} failed`, { cause: error });
      }
      store.commitIngestStep(() => {
        for (const section of sections) {
          const baseSlug = slugify(section.title);
          if (!baseSlug) continue;
          const slug = resolveGeneratedPageSlug(baseSlug, section.title, sourceId, "source", store);

          const existing = store.getPage(slug);
          if (existing?.page_type === "source" && existing.source_id === sourceId) {
            store.updatePageContent(existing.id, existing.content + "\n\n" + section.content);
          } else {
            const page = store.addPage(slug, section.title, section.content, sourceId, slug, "source", orderCounter++);
            store.addActivityLog('page_created', `Created page: ${section.title}`, 'page', page.id);
            sourcePageSummaries.push(`- ${section.title} [slug: ${slug}]: ${section.content.slice(0, 150).replace(/\n/g, " ")}`);
          }
        }
        store.setCheckpoint(sourceId, 'phase1_chunk', ci, checkpointInputHash);
      });
      completedCount++;
      onProgress?.(`Phase 1: ${completedCount}/${chunks.length} 청크 완료`);
    }

    sourceCount = orderCounter;
    store.commitIngestStep(() => {
      store.setCheckpoint(sourceId, 'phase1', 0, checkpointInputHash);
    });
    const phase1Sec = ((performance.now() - phase1Start) / 1000).toFixed(1);
    console.log(`\x1b[32m✅ Phase 1 완료 (${phase1Sec}초) — 📖 ${sourceCount}개 원본 페이지 생성\x1b[0m`);
  }

  // ── Phase 2: Extract concept pages ──
  const batchSize = 5;
  let conceptCount = 0;
  // Cache concept pages list for reuse in Phase 2 and Phase 2.5
  let cachedConceptPages: ReturnType<typeof store.listConceptPages> | null = null;

  if (sourcePageSummaries.length === 0) {
    console.log(`\x1b[33m⏭ Phase 2 건너뜀 (원본 페이지 없음)\x1b[0m`);
    onProgress?.(`Phase 2 건너뜀 (원본 페이지 없음)`);
  } else {
    const totalBatches = Math.ceil(sourcePageSummaries.length / batchSize);
    const lastCompletedBatch = store.getLastCompletedBatch(sourceId, 'phase2');

    if (lastCompletedBatch >= totalBatches - 1 && store.hasPhaseCheckpoint(sourceId, 'phase2')) {
      cachedConceptPages = store.listConceptPages()
        .filter(page => page.source_id === sourceId && page.origin === "batch");
      conceptCount = cachedConceptPages.length;
      console.log(`\x1b[32m⏭ Phase 2 건너뜀 (이미 완료) — 📝 ${conceptCount}개 개념 페이지\x1b[0m`);
      onProgress?.(`Phase 2 건너뜀 (${conceptCount}개 개념 이미 존재)`);
    } else {
      const phase2Start = performance.now();
      const resumeFrom = lastCompletedBatch + 1;
      if (resumeFrom > 0) {
        console.log(`\x1b[34m⏳ Phase 2: 개념 추출 재개 (배치 ${resumeFrom + 1}/${totalBatches}부터)...\x1b[0m`);
        onProgress?.(`Phase 2: 배치 ${resumeFrom + 1}/${totalBatches}부터 재개`);
      } else {
        console.log(`\x1b[34m⏳ Phase 2: 개념 추출 중...\x1b[0m`);
        onProgress?.(`Phase 2: 개념 추출 중...`);
      }

      // Cache existing concept titles in memory to avoid repeated DB queries
      const existingConceptTitles = new Set(store.listConceptPages().map(p => p.title));

      for (let i = 0; i < sourcePageSummaries.length; i += batchSize) {
        const batchIdx = Math.floor(i / batchSize);
        const batchLabel = `  [${batchIdx + 1}/${totalBatches}]`;

        if (batchIdx <= lastCompletedBatch) {
          console.log(`${batchLabel} 이미 완료 — 건너뜀`);
          continue;
        }

        console.log(`${batchLabel} 개념 추출 중...`);

        const batch = sourcePageSummaries.slice(i, i + batchSize);
        const existingConceptsNote = existingConceptTitles.size > 0
          ? `\n\nAlready created concept pages (do not duplicate): ${[...existingConceptTitles].join(", ")}`
          : "";
        const conceptPrompt = getConceptPrompt(persona, schema);
        const prompt = conceptPrompt.replace("{sourcePages}", batch.join("\n")) + existingConceptsNote;
        const conceptSystem = getConceptSystem(persona, schema);

        try {
          const raw = await chat(conceptSystem, prompt, 16384);
          const concepts = parseConceptResponse(raw);

          store.commitIngestStep(() => {
            for (const concept of concepts) {
              const baseSlug = slugify(concept.title);
              if (!baseSlug) continue;
              const slug = resolveGeneratedPageSlug(baseSlug, concept.title, sourceId, "concept", store);

              const existing = store.getPage(slug);
              if (existing?.page_type === "concept" && existing.source_id === sourceId) continue;

              let content = concept.content;
              // Apply term standardization if schema.terms is defined
              if (compiledTerms) {
                content = standardizeTerms(content, compiledTerms);
              }
              if (concept.suggested_links?.length) {
                content += "\n\n## External References\n\n";
                for (const link of concept.suggested_links) {
                  content += `- [${link.text}](${link.url})\n`;
                }
              }

              const conceptPage = store.addPage(slug, concept.title, content, sourceId, slug, "concept", 0);
              store.addActivityLog('page_created', `Created page: ${concept.title}`, 'page', conceptPage.id);
              // Store category if provided by LLM and schema supports it
              if (concept.category && schema?.categories?.length) {
                store.updatePageCategory(conceptPage.id, concept.category);
              }
              existingConceptTitles.add(concept.title);
              conceptCount++;
            }
            store.setCheckpoint(sourceId, 'phase2', batchIdx, checkpointInputHash);
          });
          console.log(`    → ${concepts.length}개 개념`);
          onProgress?.(`Phase 2: ${batchIdx + 1}/${totalBatches} 배치 완료`);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          console.log(`    \x1b[31m✗ 배치 ${batchIdx + 1} 실패: ${message}\x1b[0m`);
          throw new Error(`Phase 2 batch ${batchIdx + 1}/${totalBatches} failed`, { cause: e });
        }
      }

      const phase2Sec = ((performance.now() - phase2Start) / 1000).toFixed(1);
      console.log(`\x1b[32m✅ Phase 2 완료 (${phase2Sec}초) — 📝 ${conceptCount}개 개념 페이지 생성\x1b[0m`);
      // Invalidate cache since new concepts were added
      cachedConceptPages = null;
    }
  }

  // ── Phase 2 post-processing: Parse citation markers ──
  if (!store.hasPhaseCheckpoint(sourceId, "phase2_citations")) {
    let citationCount = 0;
    store.commitIngestStep(() => {
      const conceptPagesForCitations = store.listConceptPages()
        .filter(page => page.source_id === sourceId && page.origin === "batch");
      for (const page of conceptPagesForCitations) {
        if (page.content.includes("[^src:")) {
          const parsed = parseCitations(page.content, page.id, store);
          if (parsed !== page.content) {
            store.updatePageContent(page.id, parsed);
            citationCount++;
          }
        }
      }
      store.setCheckpoint(sourceId, "phase2_citations", 0, checkpointInputHash);
    });
    if (citationCount > 0) {
      console.log(`\x1b[32m  📚 ${citationCount}개 페이지에서 인용 정보 생성 완료\x1b[0m`);
    }
  }

  // ── Phase 2.5: Generate quizzes from concept pages ──
  let quizCount = 0;
  if (store.hasPhaseCheckpoint(sourceId, 'phase2_5')) {
    console.log(`\x1b[32m⏭ Phase 2.5 건너뜀 (퀴즈 이미 생성됨)\x1b[0m`);
    onProgress?.(`Phase 2.5 건너뜀 (퀴즈 이미 존재)`);
  } else {
    const conceptPagesForQuiz = (cachedConceptPages ?? store.listConceptPages())
      .filter(page => page.source_id === sourceId && page.origin === "batch");
    if (conceptPagesForQuiz.length > 0) {
      console.log(`\x1b[34m⏳ Phase 2.5: 퀴즈 생성 중... (${conceptPagesForQuiz.length}개 개념 페이지)\x1b[0m`);
      onProgress?.(`Phase 2.5: 퀴즈 생성 중...`);

      let quizSystemExtra = "";
      if (schema?.terms && Object.keys(schema.terms).length > 0) {
        const termList = Object.entries(schema.terms).map(([k, v]) => `${k} -> ${v}`).join(", ");
        quizSystemExtra = `\nUse these standard terms in questions and answers (replace abbreviations with full forms): ${termList}`;
      }
      const quizSystem = `You are a quiz generator for a study wiki. Generate quiz questions that test UNDERSTANDING, not just memorization.
Focus on higher-order thinking: "왜?", "어떻게?", "비교하라", "설명하라" style questions.${quizSystemExtra}
Return valid JSON only. No markdown fences.`;

      try {
        // Generate and validate every response before persisting any quiz. A
        // malformed or failed response must not produce a completed phase.
        const generated = await parallelMap(conceptPagesForQuiz, 3, async (page) => {
          const quizPrompt = `Based on this wiki content, generate 2-3 quiz questions that test UNDERSTANDING, not just memorization.
Include questions that ask "왜?", "어떻게?", "비교하라" etc.
Types: "fill_blank" (빈칸 채우기), "ox" (OX 퀴즈 - true/false), "short_answer" (단답형)

Content title: ${page.title}
Content:
${page.content.slice(0, 3000)}

Respond with a JSON array only:
[{"question": "___은 양자역학에서 위치와 운동량을 동시에 측정할 수 없다는 원리이다.", "answer": "불확정성 원리", "explanation": "이 원리는 양자역학의 근본적 한계를 보여주며, 측정 행위 자체가 시스템에 영향을 주기 때문입니다.", "type": "fill_blank"}]

Rules:
- For fill_blank: use ___ to mark the blank in the question
- For ox: question should be a statement, answer should be "O" or "X"
- For short_answer: question should be answerable in 1-3 words
- Include "explanation" field: a brief 1-2 sentence explanation of WHY the answer is correct
- Questions should test understanding, application, or analysis — not just recall
- Write questions in Korean when the content is in Korean`;

          const raw = await chat(quizSystem, quizPrompt, 2048);
          return { page, quizzes: parseQuizResponse(raw) };
        });

        store.commitIngestStep(() => {
          for (const { page, quizzes } of generated) {
            for (const q of quizzes) {
              const question = compiledTerms ? standardizeTerms(q.question, compiledTerms) : q.question;
              const answer = compiledTerms ? standardizeTerms(q.answer, compiledTerms) : q.answer;
              const explanation = compiledTerms && q.explanation ? standardizeTerms(q.explanation, compiledTerms) : (q.explanation || "");
              store.addQuiz(page.id, question, answer, q.type, explanation);
              quizCount++;
            }
          }
          store.setCheckpoint(sourceId, 'phase2_5', 0, checkpointInputHash);
        });
        console.log(`\x1b[32m  🧩 ${quizCount}개 퀴즈 생성 완료\x1b[0m`);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`\x1b[31m  ✗ 퀴즈 생성 단계 실패: ${message}\x1b[0m`);
        throw new Error("Phase 2.5 quiz generation failed", { cause: e });
      }
    }
  }

  // ── Phase 3: Resolve wiki links + inject concept links into source pages ──
  if (!store.hasPhaseCheckpoint(sourceId, "phase3")) {
  store.commitIngestStep(() => {
  console.log(`\x1b[34m🔗 위키 링크 해석 중...\x1b[0m`);
  const allPages = store.listPages();
  const generatedPages = allPages.filter(
    page => page.source_id === sourceId && page.origin === "batch",
  );
  const slugMap = new Map(allPages.map(p => [p.slug, { id: p.id, slug: p.slug }]));
  for (const p of allPages) {
    const titleSlug = slugify(p.title);
    if (!slugMap.has(titleSlug)) slugMap.set(titleSlug, { id: p.id, slug: p.slug });
  }

  // Resolve [[wiki links]] in concept pages
  let linkedPages = 0;
  for (const page of generatedPages.filter(page => page.page_type === "concept")) {
    if (!page.content.includes("[[")) continue;
    const resolved = resolveWikiLinks(page.id, page.content, slugMap, store);
    if (resolved !== page.content) {
      store.updatePageContent(page.id, resolved);
      linkedPages++;
    }
  }

  // Inject concept links into source pages
  const conceptPages = allPages.filter(p => p.page_type === "concept");
  const srcPages = generatedPages.filter(p => p.page_type === "source");

  // Build search terms: full title + key words from title (2+ words long)
  const searchTerms: Array<{ term: string; concept: typeof conceptPages[0]; regex: RegExp | null }> = [];
  for (const concept of conceptPages) {
    searchTerms.push({ term: concept.title, concept, regex: null });
    // Also try individual significant words from multi-word titles
    const words = concept.title.split(/\s+/).filter(w => w.length >= 4 && !/^(and|the|for|with|from|into)$/i.test(w));
    if (words.length >= 2) {
      // Try pairs of consecutive words
      for (let i = 0; i < words.length - 1; i++) {
        searchTerms.push({ term: `${words[i]} ${words[i + 1]}`, concept, regex: null });
      }
    }
  }
  // Sort by term length descending for longest match first
  searchTerms.sort((a, b) => b.term.length - a.term.length);

  // Pre-compile RegExp objects outside the page loop
  for (const entry of searchTerms) {
    if (entry.term.length < 3) continue;
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    entry.regex = new RegExp(`(?<!\\[)(?<![\\w/])(${escaped})(?![\\w])(?!\\])(?![^[]*\\])`, "i");
  }

  for (const srcPage of srcPages) {
    let content = srcPage.content;
    let modified = false;
    const linkedConcepts = new Set<number>();

    for (const { term, concept, regex } of searchTerms) {
      if (linkedConcepts.has(concept.id)) continue; // One link per concept per page
      if (term.length < 3 || !regex) continue;
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
  store.setCheckpoint(sourceId, "phase3", 0, checkpointInputHash);
  });
  }

  return { sourceCount, conceptCount };
}

export async function htmlToRawText(html: string): Promise<string> {
  const { load } = await import("cheerio");
  const $ = load(html);
  $("script, style, nav, header, footer, noscript").remove();
  return $("body").text() || $.text();
}
