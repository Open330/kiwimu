import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../store";

describe("Store repositories", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("quiz repository and Store facade share quiz, SRS, attempt, and activity state", () => {
    const source = store.addSource("file:///quiz.pdf", "pdf", "Quiz source", "raw");
    const page = store.addPage("quiz-page", "Quiz page", "body", source.id);

    store.quizRepository.addQuiz(page.id, "Question?", "Answer", "short_answer", "Why");
    const [quiz] = store.getQuizzesByPage(page.id);
    expect(quiz).toMatchObject({
      question: "Question?",
      explanation: "Why",
      page_title: "Quiz page",
    });
    expect(store.getQuizStats()).toEqual({
      total: 0,
      correct: 0,
      incorrect: 0,
      unattempted: 1,
    });

    store.addQuizAttempt(quiz.id, false);
    store.quizRepository.updateQuizSRS(quiz.id, 2);

    expect(store.quizRepository.getQuizHistory(1)[0]).toMatchObject({
      quiz_id: quiz.id,
      is_correct: false,
    });
    expect(store.getQuizStats()).toEqual({
      total: 1,
      correct: 0,
      incorrect: 1,
      unattempted: 0,
    });
    expect(store.activityRepository.getActivityLog(1)[0]).toMatchObject({
      action: "quiz_attempted",
      entity_id: quiz.id,
    });
  });

  test("activity repository and Store facade share activity and usage projections", () => {
    store.activityRepository.addActivityLog(
      "page_created",
      "Created a page",
      "page",
      42,
      { origin: "test" },
    );
    store.addUsageLog(null, 2, 100, 50, 150, 0.01);
    store.activityRepository.addUsageLog(null, 1, 20, 10, 30, 0.002);

    expect(store.getActivityLog()).toHaveLength(1);
    expect(store.getActivityStats()).toMatchObject({
      total: 1,
      byAction: { page_created: 1 },
    });
    expect(store.getUsageSummary()).toEqual({
      totalCalls: 3,
      promptTokens: 120,
      completionTokens: 60,
      totalTokens: 180,
      totalCost: 0.012,
    });
  });

  test("activity pagination has a stable newest-first id tie-break", () => {
    for (const title of ["first", "second", "third"]) {
      store.activityRepository.addActivityLog("build", title);
    }

    const firstPage = store.getActivityLog(2, 0, "build");
    const secondPage = store.getActivityLog(2, 2, "build");

    expect(firstPage.map((entry) => entry.title)).toEqual(["third", "second"]);
    expect(secondPage.map((entry) => entry.title)).toEqual(["first"]);
    expect(new Set([...firstPage, ...secondPage].map((entry) => entry.id)).size).toBe(3);
  });

  test("citation repository and Store facade share joined provenance data", () => {
    const source = store.addSource("file:///citation.pdf", "pdf", "Citation source", "raw");
    const sourcePage = store.addPage(
      "citation-source",
      "Citation source page",
      "source body",
      source.id,
      undefined,
      "source",
    );
    const conceptPage = store.addPage("citation-concept", "Concept", "concept body");

    const citationId = store.citationRepository.addCitation(
      conceptPage.id,
      source.id,
      sourcePage.id,
      "excerpt",
      "context",
    );
    expect(citationId).toBeGreaterThan(0);
    expect(store.getCitationsForPage(conceptPage.id)[0]).toMatchObject({
      id: citationId,
      source_title: "Citation source",
      source_page_slug: "citation-source",
    });
    expect(store.citationRepository.getCitationsForSource(source.id)[0]).toMatchObject({
      page_slug: "citation-concept",
      excerpt: "excerpt",
    });
    expect(store.getSourceCoverage()).toEqual([
      {
        sourceId: source.id,
        sourceTitle: "Citation source",
        citationCount: 1,
        pageCount: 1,
      },
    ]);
  });

  test("citation replacement atomically publishes a complete successful set", () => {
    const source = store.addSource("file:///replace.pdf", "pdf", "Replace source", "raw");
    const first = store.addPage("replace-first", "First", "body", source.id);
    const second = store.addPage("replace-second", "Second", "body", source.id);
    const concept = store.addPage("replace-concept", "Concept", "body");
    store.addCitation(concept.id, source.id, first.id, "old");

    const ids = store.replaceCitations(concept.id, [
      { sourceId: source.id, sourcePageId: first.id, excerpt: "first" },
      { sourceId: source.id, sourcePageId: second.id, context: "second context" },
    ]);

    expect(ids).toHaveLength(2);
    expect(store.getCitationsForPage(concept.id).map(({ excerpt, context }) => ({ excerpt, context }))).toEqual([
      { excerpt: "first", context: null },
      { excerpt: null, context: "second context" },
    ]);
  });

  test("citation replacement rolls the deletion back when any insert fails", () => {
    const source = store.addSource("file:///rollback.pdf", "pdf", "Rollback source", "raw");
    const sourcePage = store.addPage("rollback-source", "Source", "body", source.id);
    const concept = store.addPage("rollback-concept", "Concept", "body");
    const originalId = store.addCitation(concept.id, source.id, sourcePage.id, "original");

    expect(() => store.replaceCitations(concept.id, [
      { sourceId: source.id, sourcePageId: sourcePage.id, excerpt: "would be inserted" },
      { sourceId: 999_999, excerpt: "violates the source foreign key" },
    ])).toThrow();

    expect(store.getCitationsForPage(concept.id)).toHaveLength(1);
    expect(store.getCitationsForPage(concept.id)[0]).toMatchObject({ id: originalId, excerpt: "original" });
  });

  test("citation replacement with an empty set atomically clears the page", () => {
    const source = store.addSource("file:///clear.pdf", "pdf", "Clear source", "raw");
    const page = store.addPage("clear-page", "Clear", "body", source.id);
    store.addCitation(page.id, source.id, page.id);

    expect(store.replaceCitations(page.id, [])).toEqual([]);
    expect(store.getCitationsForPage(page.id)).toEqual([]);
  });

  test("competing process replacements never leave a mixed citation set", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "kiwimu-citations-"));
    const dbPath = join(tempRoot, "wiki.db");
    const sharedStore = new Store(dbPath);
    try {
      const source = sharedStore.addSource("file:///concurrent.pdf", "pdf", "Concurrent source", "raw");
      const sourcePage = sharedStore.addPage("concurrent-source", "Source", "body", source.id);
      const concept = sharedStore.addPage("concurrent-concept", "Concept", "body");
      const repositoryUrl = pathToFileURL(join(import.meta.dir, "citation-repository.ts")).href;
      const startAt = Date.now() + 250;
      const spawnReplacement = (label: string) => {
        const inputs = Array.from({ length: 20 }, (_, index) => ({
          sourceId: source.id,
          sourcePageId: sourcePage.id,
          context: `${label}-${index}`,
        }));
        const code = [
          `import { Database } from "bun:sqlite";`,
          `import { CitationRepository } from ${JSON.stringify(repositoryUrl)};`,
          `while (Date.now() < ${startAt}) {}`,
          `const db = new Database(${JSON.stringify(dbPath)});`,
          `db.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;");`,
          `new CitationRepository(db).replaceCitations(${concept.id}, ${JSON.stringify(inputs)});`,
          `db.close();`,
        ].join("\n");
        return Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
      };

      const processes = [spawnReplacement("A"), spawnReplacement("B")];
      const exitCodes = await Promise.all(processes.map((process) => process.exited));
      if (exitCodes.some((code) => code !== 0)) {
        const errors = await Promise.all(processes.map((process) => new Response(process.stderr).text()));
        throw new Error(`replacement subprocess failed: ${errors.join("\n")}`);
      }

      const contexts = sharedStore.getCitationsForPage(concept.id).map((citation) => citation.context);
      expect(contexts).toHaveLength(20);
      const winningLabels = new Set(contexts.map((context) => context?.slice(0, 1)));
      expect(winningLabels.size).toBe(1);
      const [winningLabel] = winningLabels;
      expect(winningLabel === "A" || winningLabel === "B").toBeTrue();
    } finally {
      sharedStore.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("Store deletion keeps repository-owned dependent data cleanup compatible", () => {
    const source = store.addSource("file:///cleanup.pdf", "pdf", "Cleanup", "raw");
    const page = store.addPage("cleanup", "Cleanup", "body", source.id);
    store.addQuiz(page.id, "Question?", "Answer", "short_answer");
    store.addCitation(page.id, source.id, page.id);

    store.deletePagesBySource(source.id);

    expect(store.quizRepository.getAllQuizzes()).toEqual([]);
    expect(store.citationRepository.getCitationsForSource(source.id)).toEqual([]);
  });
});
