import { LLMClient } from "../llm-client";
import type { Store } from "../store";
import { slugify } from "./chunker";
import type { Persona, WikiSchema } from "../config";
import { compileTerms, standardizeTerms } from "./standardizer";

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

Return a JSON array where each element has:
- "title": string — Short concept name, 1-3 words (e.g., "Synchrotron Radiation", "Flux Density", "Angular Resolution"). Keep titles short so they match naturally in text.
- "content": string — Educational markdown content with [[wiki links]] to other concepts and source pages${categoryField}
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
  persona: Persona | null = null,
  llmClient: LLMClient,
  onProgress?: (status: string) => void,
  schema?: WikiSchema
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
    const existingPages = store.getSourcePages(sourceId);
    sourceCount = existingPages.length;
    sourcePageSummaries = existingPages.map(p =>
      `- ${p.title}: ${p.content.slice(0, 150).replace(/\n/g, " ")}`
    );
    console.log(`\x1b[32m⏭ Phase 1 건너뜀 (이미 완료) — 📖 ${sourceCount}개 원본 페이지\x1b[0m`);
    onProgress?.(`Phase 1 건너뜀 (${sourceCount}개 페이지 이미 존재)`);
  } else {
    console.log(`\x1b[34m⏳ Phase 1: 원본 구조 추출 중... (${chunks.length}개 청크)\x1b[0m`);
    onProgress?.(`Phase 1: 원본 구조 추출 중... (${chunks.length}개 청크)`);

    const phase1Start = performance.now();
    let completedCount = 0;
    const structureSystem = getStructureSystem(persona);

    const chunkResults = await parallelMap(chunks, 3, async (chunk, i) => {
      console.log(`  Phase 1: 처리 중 [${i + 1}/${chunks.length}] ${chunk.chapterHint}...`);

      const prompt = STRUCTURE_PROMPT
        .replace("{sourceTitle}", sourceTitle)
        .replace("{text}", chunk.text.slice(0, 80000));

      try {
        let raw = await chat(structureSystem, prompt, 16384);
        if (!raw || raw.trim().length < 10) {
          console.log(`    \x1b[33m⚠ 빈 응답, 재시도...\x1b[0m`);
          raw = await chat(structureSystem, prompt, 16384);
          if (!raw || raw.trim().length < 10) {
            console.log(`    \x1b[31m✗ 재시도도 빈 응답\x1b[0m`);
            completedCount++;
            return [] as StructurePage[];
          }
        }
        const sections = parseJSON<StructurePage[]>(raw).filter(s => s.title && s.content && s.content.length > 30);
        completedCount++;
        console.log(`    → ${sections.length}개 섹션 (완료 ${completedCount}/${chunks.length})`);
        onProgress?.(`Phase 1: ${completedCount}/${chunks.length} 청크 완료`);
        return sections;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`    \x1b[31m✗ 실패: ${message}\x1b[0m`);
        completedCount++;
        return [] as StructurePage[];
      }
    });

    // Store results sequentially (SQLite writes must be sequential)
    let orderCounter = 0;
    sourcePageSummaries = [];

    for (const sections of chunkResults) {
      for (const section of sections) {
        const slug = slugify(section.title);
        if (!slug) continue;

        const existing = store.getPage(slug);
        if (existing) {
          store.updatePageContent(existing.id, existing.content + "\n\n" + section.content);
        } else {
          const page = store.addPage(slug, section.title, section.content, sourceId, slug, "source", orderCounter++);
          store.addActivityLog('page_created', `Created page: ${section.title}`, 'page', page.id);
          sourcePageSummaries.push(`- ${section.title}: ${section.content.slice(0, 150).replace(/\n/g, " ")}`);
        }
      }
    }

    sourceCount = orderCounter;
    store.setCheckpoint(sourceId, 'phase1');
    const phase1Sec = ((performance.now() - phase1Start) / 1000).toFixed(1);
    console.log(`\x1b[32m✅ Phase 1 완료 (${phase1Sec}초) — 📖 ${sourceCount}개 원본 페이지 생성\x1b[0m`);
  }

  // ── Phase 2: Extract concept pages ──
  const batchSize = 5;
  let conceptCount = 0;

  if (sourcePageSummaries.length === 0) {
    console.log(`\x1b[33m⏭ Phase 2 건너뜀 (원본 페이지 없음)\x1b[0m`);
    onProgress?.(`Phase 2 건너뜀 (원본 페이지 없음)`);
  } else {
    const totalBatches = Math.ceil(sourcePageSummaries.length / batchSize);
    const lastCompletedBatch = store.getLastCompletedBatch(sourceId, 'phase2');

    if (lastCompletedBatch >= totalBatches - 1 && store.hasPhaseCheckpoint(sourceId, 'phase2')) {
      conceptCount = store.listConceptPages().length;
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
          const concepts = parseJSON<ConceptPage[]>(raw).filter(c => c.title && c.content && c.content.length > 50);

          for (const concept of concepts) {
            const slug = slugify(concept.title);
            if (!slug) continue;

            const existing = store.getPage(slug);
            if (existing) continue;

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
          store.setCheckpoint(sourceId, 'phase2', batchIdx);
          console.log(`    → ${concepts.length}개 개념`);
          onProgress?.(`Phase 2: ${batchIdx + 1}/${totalBatches} 배치 완료`);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          console.log(`    \x1b[31m✗ 배치 ${batchIdx + 1} 실패 (건너뜀): ${message}\x1b[0m`);
          // Non-retryable errors (parse failures, etc.) — skip batch, continue pipeline
          // Rate-limit errors are already retried in LLMClient; if we reach here, retries exhausted
          store.setCheckpoint(sourceId, 'phase2', batchIdx);
        }
      }

      const phase2Sec = ((performance.now() - phase2Start) / 1000).toFixed(1);
      console.log(`\x1b[32m✅ Phase 2 완료 (${phase2Sec}초) — 📝 ${conceptCount}개 개념 페이지 생성\x1b[0m`);
    }
  }

  // ── Phase 2.5: Generate quizzes from concept pages ──
  let quizCount = 0;
  if (store.hasPhaseCheckpoint(sourceId, 'phase2_5')) {
    console.log(`\x1b[32m⏭ Phase 2.5 건너뜀 (퀴즈 이미 생성됨)\x1b[0m`);
    onProgress?.(`Phase 2.5 건너뜀 (퀴즈 이미 존재)`);
  } else {
    try {
      const conceptPagesForQuiz = store.listConceptPages();
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

        await parallelMap(conceptPagesForQuiz, 3, async (page, i) => {
          try {
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
            const quizzes = parseJSON<Array<{ question: string; answer: string; explanation?: string; type: string }>>(raw);

            for (const q of quizzes) {
              if (q.question && q.answer && q.type) {
                const question = compiledTerms ? standardizeTerms(q.question, compiledTerms) : q.question;
                const answer = compiledTerms ? standardizeTerms(q.answer, compiledTerms) : q.answer;
                const explanation = compiledTerms && q.explanation ? standardizeTerms(q.explanation, compiledTerms) : (q.explanation || "");
                store.addQuiz(page.id, question, answer, q.type, explanation);
                quizCount++;
              }
            }
          } catch (e: unknown) {
            // Quiz generation is non-critical; silently skip failures
            const message = e instanceof Error ? e.message : String(e);
            console.log(`    \x1b[33m⚠ 퀴즈 생성 실패 (${page.title}): ${message}\x1b[0m`);
          }
        });

        store.setCheckpoint(sourceId, 'phase2_5');
        console.log(`\x1b[32m  🧩 ${quizCount}개 퀴즈 생성 완료\x1b[0m`);
      }
    } catch (e: unknown) {
      // Phase 2.5 is optional — don't block the pipeline
      const message = e instanceof Error ? e.message : String(e);
      console.log(`\x1b[33m  ⚠ 퀴즈 생성 단계 건너뜀: ${message}\x1b[0m`);
    }
  }

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

  return { sourceCount, conceptCount };
}

export async function htmlToRawText(html: string): Promise<string> {
  const { load } = await import("cheerio");
  const $ = load(html);
  $("script, style, nav, header, footer, noscript").remove();
  return $("body").text() || $.text();
}
