import { expect, test, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { IngestManualEditConflictError, Store } from "../store";
import { LLMClient } from "../llm-client";
import { promoteToWiki } from "./promote";
import type { LLMConfig } from "../config";

// Characterization tests for promoting a Q&A answer into a wiki concept page.
// The quiz-generation LLM call is stubbed via a prototype spy so NO live API
// call is ever made (promote constructs its own LLMClient internally).

const llmConfig: LLMConfig = { provider: "gemini", model: "test", api_key: "k", endpoint: "" };

describe("promoteToWiki", () => {
  let store: Store;
  let chatSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
    chatSpy = spyOn(LLMClient.prototype, "chatComplete").mockResolvedValue(
      JSON.stringify([
        { question: "What is X?", answer: "Y", explanation: "because", type: "short_answer" },
      ]),
    );
  });

  afterEach(() => {
    chatSpy.mockRestore();
    store.close();
  });

  test("dedup: marks an existing batch page and blocks a destructive re-ingest", async () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    const source = store.addPage("src", "Src", "s", src.id, undefined, "source", 0);
    const existing = store.addPage("entropy", "Entropy", "Original body.", src.id, undefined, "concept", 0);

    const result = await promoteToWiki(store, {
      question: "what is entropy?",
      answer: "New answer.",
      title: "entropy",
      sourcePageId: source.id,
    }, llmConfig);

    expect(result.isNew).toBe(false);
    expect(result.pageId).toBe(existing.id);
    const page = store.getPage("entropy")!;
    expect(page.content).toBe("Original body.\n\n---\n\nNew answer.");
    expect(page.manual_revision).toBe(1);
    expect(store.getForwardLinks(source.id).map(page => page.slug)).toContain("entropy");
    expect(chatSpy).not.toHaveBeenCalled();

    const staging = new Store(":memory:");
    try {
      const draft = { uri: src.uri, type: "pdf", title: "T v2", rawContent: "new raw" };
      const stagedSource = staging.seedIngestStaging(
        store.createIngestStagingSnapshot(src.uri),
        draft,
      );
      staging.addPage(
        existing.slug,
        existing.title,
        "regenerated content",
        stagedSource.id,
        undefined,
        "concept",
      );

      expect(() => store.publishIngestGeneration(
        staging,
        stagedSource.id,
        draft,
        "a".repeat(64),
      )).toThrow(IngestManualEditConflictError);
      expect(store.getPage(existing.slug)).toMatchObject({
        id: existing.id,
        content: "Original body.\n\n---\n\nNew answer.",
        manual_revision: 1,
      });
      expect(store.getSource(src.uri)).toMatchObject({ title: "T", raw_content: "raw" });
    } finally {
      staging.close();
    }
  });

  test("new page: creates a concept page, links from source, generates quizzes", async () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    const source = store.addPage("src", "Src", "s", src.id, undefined, "source", 0);

    const result = await promoteToWiki(store, {
      question: "what is gibbs free energy?",
      answer: "Gibbs free energy predicts spontaneity of reactions.",
      title: "Gibbs Free Energy",
      sourcePageId: source.id,
    }, llmConfig);

    expect(result.isNew).toBe(true);
    expect(result.slug).toBe("gibbs-free-energy");
    expect(result.title).toBe("Gibbs Free Energy");

    const page = store.getPage("gibbs-free-energy")!;
    expect(page).not.toBeNull();
    expect(page.origin).toBe("user");

    // Source page links to the new concept page
    const forward = store.getForwardLinks(source.id);
    expect(forward.map((p) => p.slug)).toContain("gibbs-free-energy");

    // Quiz produced from the stubbed LLM response
    const quizzes = store.getQuizzesByPage(page.id);
    expect(quizzes.length).toBeGreaterThanOrEqual(1);
    expect(quizzes[0].question).toBe("What is X?");
  });

  test("new page: prepends selected text as a blockquote", async () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    const source = store.addPage("src", "Src", "s", src.id, undefined, "source", 0);

    const result = await promoteToWiki(store, {
      question: "explain",
      answer: "Body answer.",
      title: "Enthalpy",
      sourcePageId: source.id,
      selectedText: "quoted context",
    }, llmConfig);

    const page = store.getPage(result.slug)!;
    expect(page.content.startsWith("> quoted context")).toBe(true);
  });

  test("new page: slug collision appends a numeric suffix", async () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    const source = store.addPage("src", "Src", "s", src.id, undefined, "source", 0);
    // Pre-occupy the natural slug
    store.addPage("enthalpy", "Some Other", "x", undefined, undefined, "concept", 0);

    const result = await promoteToWiki(store, {
      question: "explain enthalpy",
      answer: "Enthalpy is a state function.",
      title: "Enthalpy",
      sourcePageId: source.id,
    }, llmConfig);

    expect(result.slug).toBe("enthalpy-2");
  });

  test("new page still succeeds when quiz generation throws", async () => {
    chatSpy.mockRejectedValueOnce(new Error("boom"));
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    const source = store.addPage("src", "Src", "s", src.id, undefined, "source", 0);

    const result = await promoteToWiki(store, {
      question: "q",
      answer: "A valid answer body.",
      title: "Helmholtz Energy",
      sourcePageId: source.id,
    }, llmConfig);

    expect(result.isNew).toBe(true);
    expect(store.getQuizzesByPage(result.pageId)).toHaveLength(0);
  });
});
