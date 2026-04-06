import type { Store } from "../store";
import type { LLMConfig } from "../config";
import { stripJsonFences } from "../utils";

export interface PromoteParams {
  question: string;
  answer: string;
  title: string;
  sourcePageId: number;
  selectedText?: string;
}

export interface PromoteResult {
  pageId: number;
  slug: string;
  title: string;
  isNew: boolean;
}

/**
 * Promote a Q&A answer into a permanent wiki concept page.
 *
 * Handles deduplication (appends to an existing page when titles match),
 * slug generation, wiki-linking the new page to existing pages, parent
 * link creation, and quiz generation.
 */
export async function promoteToWiki(
  store: Store,
  params: PromoteParams,
  llmConfig: LLMConfig,
): Promise<PromoteResult> {
  const { question, answer, title, sourcePageId, selectedText } = params;

  // Deduplication: check if a similar page already exists
  const existing = store.findSimilarPage(title);
  if (existing) {
    const updatedContent = existing.content + "\n\n---\n\n" + answer;
    store.updatePageContent(existing.id, updatedContent);
    return {
      pageId: existing.id,
      slug: existing.slug,
      title: existing.title,
      isNew: false,
    };
  }

  // --- Create a new concept page ---
  const { slugify } = await import("../pipeline/chunker");
  let slug = slugify(title);
  if (!slug) slug = slugify(question);
  if (!slug) slug = `qa-${Date.now()}`;

  let finalSlug = slug;
  let counter = 2;
  while (store.getPage(finalSlug)) {
    finalSlug = `${slug}-${counter++}`;
  }

  // Build page content with optional quoted context
  let pageContent = answer;
  if (selectedText) {
    pageContent = `> ${selectedText.slice(0, 500)}\n\n${pageContent}`;
  }

  const page = store.addPage(finalSlug, title, pageContent, undefined, undefined, "concept", 0);

  // Mark as user-generated origin
  store.updatePageOrigin(finalSlug, "user", question, sourcePageId);

  // --- Wiki-link the new page to existing pages ---
  const targets = store
    .listPageSummaries()
    .filter((p) => p.id !== page.id && p.title.length >= 3)
    .sort((a, b) => b.title.length - a.title.length);

  let linkedContent = pageContent;
  const linkedSlugs = new Set<string>();
  for (const target of targets) {
    if (linkedSlugs.has(target.slug)) continue;
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?<!\\[)(?<!\\w)(${escaped})(?!\\w)(?!\\])`, "i");
    const match = regex.exec(linkedContent);
    if (match) {
      const replacement = `[${match[1]}](/wiki/${target.slug})`;
      linkedContent =
        linkedContent.slice(0, match.index) +
        replacement +
        linkedContent.slice(match.index + match[0].length);
      linkedSlugs.add(target.slug);
      store.addLink(page.id, target.id, match[1]);
    }
  }
  if (linkedSlugs.size > 0) {
    store.updatePageContent(page.id, linkedContent);
  }

  // Add link from source page to new page
  store.addLink(sourcePageId, page.id, title);

  // --- Generate 1-2 quizzes for the new concept ---
  try {
    const { LLMClient } = await import("../llm-client");
    const llmClient = new LLMClient(llmConfig);

    const quizSystem = `You are a quiz generator for a study wiki. Generate quiz questions that test UNDERSTANDING, not just memorization.
Focus on higher-order thinking: "\uc65c?", "\uc5b4\ub5bb\uac8c?", "\ube44\uad50\ud558\ub77c", "\uc124\uba85\ud558\ub77c" style questions.
Return valid JSON only. No markdown fences.`;

    const quizPrompt = `Based on this wiki content, generate 1-2 quiz questions that test UNDERSTANDING.
Types: "fill_blank" (\ube48\uce78 \ucc44\uc6b0\uae30), "ox" (OX \ud034\uc988 - true/false), "short_answer" (\ub2e8\ub2f5\ud615)

Content title: ${title}
Content:
${answer.slice(0, 3000)}

Respond with a JSON array only:
[{"question": "...", "answer": "...", "explanation": "...", "type": "fill_blank"}]

Rules:
- For fill_blank: use ___ to mark the blank in the question
- For ox: question should be a statement, answer should be "O" or "X"
- For short_answer: question should be answerable in 1-3 words
- Include "explanation" field: a brief 1-2 sentence explanation of WHY the answer is correct`;

    const raw = await llmClient.chatComplete(quizSystem, quizPrompt, 2048);
    const cleaned = stripJsonFences(raw);
    const quizzes = JSON.parse(cleaned) as Array<{
      question: string;
      answer: string;
      explanation?: string;
      type: string;
    }>;

    for (const q of quizzes) {
      if (q.question && q.answer && q.type) {
        store.addQuiz(page.id, q.question, q.answer, q.type, q.explanation || "");
      }
    }
  } catch {
    // Quiz generation is non-critical; silently skip failures
    console.log(`\x1b[33m\u26a0 \ud504\ub85c\ubaa8\ud2b8 \ud034\uc988 \uc0dd\uc131 \uc2e4\ud328\x1b[0m`);
  }

  return {
    pageId: page.id,
    slug: finalSlug,
    title,
    isNew: true,
  };
}
