import { expect, test, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { Store } from "../store";
import { LLMClient } from "../llm-client";
import { llmChunkDocument, htmlToRawText } from "./llm-chunker";
import { prepareIngestAttempt } from "../services/ingest";
import type { LLMConfig } from "../config";

const llmConfig: LLMConfig = { provider: "gemini", model: "test", api_key: "k", endpoint: "" };

// ── Pure helper ──
describe("htmlToRawText", () => {
  test("extracts body text and drops script/style/nav", async () => {
    const html =
      "<html><head><style>.x{}</style></head><body><nav>menu</nav><h1>Title</h1><p>Hello world</p><script>1</script></body></html>";
    const text = await htmlToRawText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello world");
    expect(text).not.toContain("menu");
    expect(text).not.toContain(".x{}");
  });
});

// ── Full pipeline with a routed mock (no live API) ──
describe("llmChunkDocument", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
  });

  afterEach(() => {
    store.close();
  });

  function routedClient() {
    const client = new LLMClient(llmConfig);
    spyOn(client, "chatComplete").mockImplementation(async (system: string) => {
      if (system.includes("document analyzer")) {
        // Phase 1 — structure extraction
        return JSON.stringify([
          {
            title: "Introduction",
            content: "This introduction section explains the fundamentals of the subject in careful detail.",
            level: 1,
          },
        ]);
      }
      if (system.includes("quiz generator")) {
        // Phase 2.5 — quiz generation
        return JSON.stringify([
          { question: "What is the subject about?", answer: "Fundamentals", type: "short_answer" },
        ]);
      }
      // Phase 2 — concept extraction (study wiki editor)
      return JSON.stringify([
        {
          title: "Fundamentals",
          content:
            "The fundamentals concept page collects the core ideas with enough educational substance to matter.",
          suggested_links: [],
        },
      ]);
    });
    return client;
  }

  function clientWith(
    implementation: (system: string, user: string) => Promise<string>,
  ): LLMClient {
    const client = new LLMClient(llmConfig);
    spyOn(client, "chatComplete").mockImplementation(implementation);
    return client;
  }

  const structureResponse = (title = "Introduction", content = "This introduction section explains the fundamentals of the subject in careful detail.") =>
    JSON.stringify([{ title, content, level: 1 }]);
  const conceptResponse = JSON.stringify([{
    title: "Fundamentals",
    content: "The fundamentals concept page collects the core ideas with enough educational substance to matter.",
    suggested_links: [],
  }]);
  const quizResponse = JSON.stringify([{
    question: "What is the subject about?",
    answer: "Fundamentals",
    type: "short_answer",
  }]);

  test("runs phases 1-3 and creates source + concept pages and quizzes", async () => {
    const src = store.addSource("file:///t.pdf", "pdf", "Textbook", "raw");
    const rawText = "Some plain document body without chapter markers, processed as a single chunk.";

    const result = await llmChunkDocument(rawText, "Textbook", src.id, store, 0, null, routedClient());

    expect(result.sourceCount).toBe(1);
    expect(result.conceptCount).toBe(1);

    const sourcePage = store.getPage("introduction");
    expect(sourcePage).not.toBeNull();
    expect(sourcePage!.page_type).toBe("source");

    const conceptPage = store.getPage("fundamentals");
    expect(conceptPage).not.toBeNull();
    expect(conceptPage!.page_type).toBe("concept");

    // Phase 2.5 produced a quiz for the concept page
    expect(store.getQuizzesByPage(conceptPage!.id).length).toBeGreaterThanOrEqual(1);

    // Checkpoints recorded for resumability
    expect(store.hasPhaseCheckpoint(src.id, "phase1")).toBe(true);
    expect(store.hasPhaseCheckpoint(src.id, "phase2")).toBe(true);
  });

  test("resumes: skips phase 1 when a checkpoint already exists", async () => {
    const src = store.addSource("file:///t.pdf", "pdf", "Textbook", "raw");
    // Pre-seed an already-processed source page + phase1 checkpoint
    store.addPage("intro", "Intro", "already processed content body here", src.id, "intro", "source", 0);
    store.setCheckpoint(src.id, "phase1");

    const client = routedClient();
    const spy = client.chatComplete as unknown as ReturnType<typeof spyOn>;

    const result = await llmChunkDocument("body text", "Textbook", src.id, store, 0, null, client);

    // Phase 1 skipped -> reuses the 1 existing source page, no structure call made
    expect(result.sourceCount).toBe(1);
    const calls = (spy as any).mock.calls as Array<[string, string, number?]>;
    expect(calls.some(([sys]) => sys.includes("document analyzer"))).toBe(false);
  });

  test("keeps only contiguous successful Phase 1 checkpoints before a transport failure", async () => {
    const src = store.addSource("file:///partial.md", "md", "Partial", "raw");
    const rawText = `${"A".repeat(15_000)}\n\nFAIL_MARKER ${"B".repeat(6_000)}`;
    const client = clientWith(async (system, user) => {
      if (!system.includes("document analyzer")) return "[]";
      if (user.includes("FAIL_MARKER")) throw new Error("simulated transport failure");
      return structureResponse("First Chunk");
    });

    await expect(llmChunkDocument(rawText, "Partial", src.id, store, 0, null, client))
      .rejects.toThrow("Phase 1 chunk 2/2 failed");

    expect(store.getPage("first-chunk")).not.toBeNull();
    expect(store.getLastCompletedBatch(src.id, "phase1_chunk")).toBe(0);
    expect(store.hasPhaseCheckpoint(src.id, "phase1")).toBe(false);
  });

  test("does not resume partial checkpoints created for a different input hash", async () => {
    const src = store.addSource("file:///versioned.md", "md", "Versioned", "raw");
    const v2 = `OLD_FIRST ${"A".repeat(19_980)}\n\nOLD_SECOND ${"B".repeat(5_000)}`;
    const v2Client = clientWith(async (system, user) => {
      if (!system.includes("document analyzer")) return "[]";
      if (user.includes("OLD_SECOND")) throw new Error("V2 second chunk failed");
      return structureResponse(
        "Versioned First",
        "OLD_V2 first chunk content was committed before the interrupted generation failed.",
      );
    });

    await expect(llmChunkDocument(
      v2, "Versioned", src.id, store, 0, null, v2Client, undefined, undefined, false, "hash-v2",
    )).rejects.toThrow("Phase 1 chunk 2/2 failed");
    expect(store.getSourcePages(src.id)[0].content).toContain("OLD_V2");
    expect(store.checkpointsMatchInput(src.id, "hash-v2")).toBe(true);

    const canResume = prepareIngestAttempt(store, src.id, "hash-v3");
    expect(canResume).toBe(false);
    expect(store.hasCheckpoints(src.id)).toBe(false);
    expect(store.getSourcePages(src.id)).toEqual([]);

    const v3 = `NEW_FIRST ${"C".repeat(19_980)}\n\nNEW_SECOND ${"D".repeat(5_000)}`;
    const v3Client = clientWith(async (system, user) => {
      if (!system.includes("document analyzer")) return "[]";
      return user.includes("NEW_SECOND")
        ? structureResponse("V3 Second", "NEW_V3 second chunk contains only the replacement input generation content.")
        : structureResponse("V3 First", "NEW_V3 first chunk contains only the replacement input generation content.");
    });

    await llmChunkDocument(
      v3, "Versioned", src.id, store, 0, null, v3Client, undefined, undefined, false, "hash-v3",
    );

    const regenerated = store.getSourcePages(src.id);
    expect(regenerated).toHaveLength(2);
    expect(regenerated.every((page) => page.content.includes("NEW_V3"))).toBe(true);
    expect(regenerated.some((page) => page.content.includes("OLD_V2"))).toBe(false);
    expect(store.checkpointsMatchInput(src.id, "hash-v3")).toBe(true);
  });

  test("does not checkpoint a malformed Phase 1 response", async () => {
    const src = store.addSource("file:///phase1-malformed.md", "md", "Malformed", "raw");
    const client = clientWith(async (system) => system.includes("document analyzer") ? "not-json" : "[]");

    await expect(llmChunkDocument("document body", "Malformed", src.id, store, 0, null, client))
      .rejects.toThrow("Phase 1 chunk 1/1 failed");

    expect(store.countPagesBySource(src.id)).toBe(0);
    expect(store.hasCheckpoints(src.id)).toBe(false);
  });

  test("does not complete Phase 2 after a malformed response", async () => {
    const src = store.addSource("file:///phase2-malformed.md", "md", "Malformed", "raw");
    const client = clientWith(async (system) => {
      if (system.includes("document analyzer")) return structureResponse();
      if (system.includes("study wiki editor")) return "not-json";
      return quizResponse;
    });

    await expect(llmChunkDocument("document body", "Malformed", src.id, store, 0, null, client))
      .rejects.toThrow("Phase 2 batch 1/1 failed");

    expect(store.hasPhaseCheckpoint(src.id, "phase1")).toBe(true);
    expect(store.hasPhaseCheckpoint(src.id, "phase2")).toBe(false);
  });

  test("does not complete Phase 2 after a transport failure", async () => {
    const src = store.addSource("file:///phase2-transport.md", "md", "Transport", "raw");
    const client = clientWith(async (system) => {
      if (system.includes("document analyzer")) return structureResponse();
      if (system.includes("study wiki editor")) throw new Error("phase2 transport failure");
      return quizResponse;
    });

    await expect(llmChunkDocument("document body", "Transport", src.id, store, 0, null, client))
      .rejects.toThrow("Phase 2 batch 1/1 failed");

    expect(store.hasPhaseCheckpoint(src.id, "phase2")).toBe(false);
  });

  test("does not complete quiz generation after a malformed response", async () => {
    const src = store.addSource("file:///quiz-malformed.md", "md", "Quiz", "raw");
    const client = clientWith(async (system) => {
      if (system.includes("document analyzer")) return structureResponse();
      if (system.includes("study wiki editor")) return conceptResponse;
      return JSON.stringify([{ question: "Missing answer", type: "short_answer" }]);
    });

    await expect(llmChunkDocument("document body", "Quiz", src.id, store, 0, null, client))
      .rejects.toThrow("Phase 2.5 quiz generation failed");

    expect(store.hasPhaseCheckpoint(src.id, "phase2")).toBe(true);
    expect(store.hasPhaseCheckpoint(src.id, "phase2_5")).toBe(false);
    expect(store.getAllQuizzes()).toEqual([]);
  });

  test("does not complete quiz generation after a transport failure", async () => {
    const src = store.addSource("file:///quiz-transport.md", "md", "Quiz", "raw");
    const client = clientWith(async (system) => {
      if (system.includes("document analyzer")) return structureResponse();
      if (system.includes("study wiki editor")) return conceptResponse;
      throw new Error("quiz transport failure");
    });

    await expect(llmChunkDocument("document body", "Quiz", src.id, store, 0, null, client))
      .rejects.toThrow("Phase 2.5 quiz generation failed");

    expect(store.hasPhaseCheckpoint(src.id, "phase2_5")).toBe(false);
    expect(store.getAllQuizzes()).toEqual([]);

    const resumedClient = clientWith(async (system) => {
      if (system.includes("quiz generator")) return quizResponse;
      throw new Error("completed phases should not call the LLM during quiz resume");
    });
    await llmChunkDocument("document body", "Quiz", src.id, store, 0, null, resumedClient);

    expect(store.hasPhaseCheckpoint(src.id, "phase2_5")).toBe(true);
    expect(store.getQuizzesByPage(store.getPage("fundamentals")!.id)).toHaveLength(1);
  });

  test("does not regenerate quizzes for concepts owned by another source", async () => {
    const sourceA = store.addSource("file:///source-a.md", "md", "Source A", "raw");
    const sourceB = store.addSource("file:///source-b.md", "md", "Source B", "raw");
    const quizPrompts: string[] = [];
    const client = clientWith(async (system, user) => {
      if (system.includes("document analyzer")) {
        const isSourceA = user.includes('Source: "Source A"');
        return structureResponse(
          isSourceA ? "Source A Section" : "Source B Section",
          isSourceA
            ? "Source A explains its own subject with enough detail for concept extraction and quiz generation."
            : "Source B explains a separate subject with enough detail for concept extraction and quiz generation.",
        );
      }
      if (system.includes("study wiki editor")) {
        const isSourceA = user.includes("[slug: source-a-section]");
        return JSON.stringify([{
          title: isSourceA ? "Source A Concept" : "Source B Concept",
          content: isSourceA
            ? "Source A concept contains enough educational content to support an understanding-focused quiz question."
            : "Source B concept contains enough educational content to support an understanding-focused quiz question.",
          suggested_links: [],
        }]);
      }
      quizPrompts.push(user);
      return quizResponse;
    });

    await llmChunkDocument("source A body", "Source A", sourceA.id, store, 0, null, client);
    const sourceAConcept = store.getPage("source-a-concept")!;
    const sourceAQuizCount = store.getQuizzesByPage(sourceAConcept.id).length;

    await llmChunkDocument("source B body", "Source B", sourceB.id, store, 0, null, client);

    expect(store.getQuizzesByPage(sourceAConcept.id)).toHaveLength(sourceAQuizCount);
    expect(store.getQuizzesByPage(store.getPage("source-b-concept")!.id)).toHaveLength(1);
    expect(quizPrompts.filter(prompt => prompt.includes("Content title: Source A Concept"))).toHaveLength(1);
    expect(quizPrompts.filter(prompt => prompt.includes("Content title: Source B Concept"))).toHaveLength(1);
  });

  test("post-processing mutates only generated pages owned by the target source", async () => {
    const foreign = store.addSource("file:///foreign.md", "md", "Foreign", "raw");
    const foreignConceptContent =
      "A foreign user-facing concept keeps the explicit [[New Target Concept]] marker unchanged.";
    const foreignSourceContent =
      "New Target Concept appears here, but another source ingest must not inject a link into this page.";
    const foreignConcept = store.addPage(
      "foreign-concept", "Foreign concept", foreignConceptContent,
      foreign.id, undefined, "concept",
    );
    const foreignSourcePage = store.addPage(
      "foreign-section", "Foreign section", foreignSourceContent,
      foreign.id, undefined, "source",
    );
    const target = store.addSource("file:///target.md", "md", "Target", "raw");
    const targetUserContent = "A target-owned user note also keeps [[New Target Concept]] unchanged.";
    const targetUserPage = store.addPage(
      "target-user-note", "Target user note", targetUserContent,
      target.id, undefined, "concept",
    );
    store.updatePageOrigin(targetUserPage.slug, "user", "question", targetUserPage.id);
    const quizPrompts: string[] = [];
    const client = clientWith(async (system, user) => {
      if (system.includes("document analyzer")) {
        return structureResponse(
          "Target section",
          "The New Target Concept is described in enough detail for target-owned link injection.",
        );
      }
      if (system.includes("study wiki editor")) {
        return JSON.stringify([{
          title: "New Target Concept",
          content: "This new target concept contains enough educational content for scoped post-processing.",
          suggested_links: [],
        }]);
      }
      quizPrompts.push(user);
      return quizResponse;
    });

    await llmChunkDocument("target body", "Target", target.id, store, 0, null, client);

    expect(store.getPage(foreignConcept.slug)?.content).toBe(foreignConceptContent);
    expect(store.getPage(foreignSourcePage.slug)?.content).toBe(foreignSourceContent);
    expect(store.getPage(targetUserPage.slug)?.content).toBe(targetUserContent);
    expect(quizPrompts.some(prompt => prompt.includes("Content title: Target user note"))).toBeFalse();
    expect(store.getPage("target-section")?.content).toContain(
      "[New Target Concept](/wiki/new-target-concept)",
    );
  });

  test("uses a stable source suffix instead of appending across source slug collisions", async () => {
    const first = store.addSource("file:///first.md", "md", "First", "raw");
    const second = store.addSource("file:///second.md", "md", "Second", "raw");
    const client = clientWith(async (system, user) => {
      if (system.includes("document analyzer")) {
        const content = user.includes('Source: "First"')
          ? "First source has its own sufficiently detailed section content for collision testing."
          : "Second source has different sufficiently detailed section content for collision testing.";
        return structureResponse("Shared Heading", content);
      }
      return "[]";
    });

    await llmChunkDocument("first body", "First", first.id, store, 0, null, client);
    await llmChunkDocument("second body", "Second", second.id, store, 0, null, client);

    const firstPage = store.getPage("shared-heading");
    const secondPage = store.getPage(`shared-heading-source-${second.id}`);
    expect(firstPage?.source_id).toBe(first.id);
    expect(secondPage?.source_id).toBe(second.id);
    expect(store.countPagesBySource(first.id)).toBe(1);
    expect(store.countPagesBySource(second.id)).toBe(1);
    expect(firstPage?.content).toContain("First source");
    expect(firstPage?.content).not.toContain("Second source");
    expect(secondPage?.content).toContain("Second source");
  });

  test("appends repeated headings only within the same source", async () => {
    const src = store.addSource("file:///same.md", "md", "Same", "raw");
    const client = clientWith(async (system) => {
      if (!system.includes("document analyzer")) return "[]";
      return JSON.stringify([
        { title: "Repeated", content: "First repeated section contains sufficiently detailed educational content.", level: 1 },
        { title: "Repeated", content: "Second repeated section contains different sufficiently detailed educational content.", level: 2 },
      ]);
    });

    const result = await llmChunkDocument("same source body", "Same", src.id, store, 0, null, client);

    expect(result.sourceCount).toBe(1);
    expect(store.getPage("repeated")?.content).toContain("First repeated section");
    expect(store.getPage("repeated")?.content).toContain("Second repeated section");
  });

  test("keeps distinct generated concepts whose titles normalize to the same slug", async () => {
    const src = store.addSource("file:///languages.md", "md", "Languages", "raw");
    const client = clientWith(async (system) => {
      if (system.includes("document analyzer")) return structureResponse("Language overview");
      if (system.includes("study wiki editor")) {
        return JSON.stringify([
          {
            title: "C++",
            content: "C++ is a systems programming language with deterministic object lifetimes and templates.",
            suggested_links: [],
          },
          {
            title: "C#",
            content: "C# is a managed programming language centered on the common language runtime.",
            suggested_links: [],
          },
        ]);
      }
      return quizResponse;
    });

    await llmChunkDocument("language body", "Languages", src.id, store, 0, null, client);

    const concepts = store.listConceptPages().filter((page) => page.source_id === src.id);
    expect(concepts.map((page) => page.title).sort()).toEqual(["C#", "C++"]);
    expect(new Set(concepts.map((page) => page.slug)).size).toBe(2);
    expect(concepts.some((page) => page.slug === "c")).toBe(true);
    expect(concepts.some((page) => page.slug.startsWith("c-") && page.slug !== "c")).toBe(true);
  });

  test("resolves piped wiki links while preserving unresolved and code markers", async () => {
    const src = store.addSource("file:///wiki-links.md", "md", "Wiki links", "raw");
    const linkingContent = [
      "This linking page has enough educational content to exercise explicit wiki marker resolution.",
      "Plain [[Target Page]] and [[Target Page|display label]] and [[Missing Page|missing label]].",
      "Inline `[[Target Page|inline label]]`.",
      "```md",
      "[[Target Page|fenced label]]",
      "```",
    ].join("\n\n");
    const client = clientWith(async (system) => {
      if (system.includes("document analyzer")) return structureResponse();
      if (system.includes("study wiki editor")) {
        return JSON.stringify([
          {
            title: "Target Page",
            content: "This target concept contains sufficiently detailed educational content for wiki link resolution.",
            suggested_links: [],
          },
          { title: "Linking Page", content: linkingContent, suggested_links: [] },
        ]);
      }
      return quizResponse;
    });

    await llmChunkDocument("document body", "Wiki links", src.id, store, 0, null, client);

    const linkingPage = store.getPage("linking-page");
    const targetPage = store.getPage("target-page");
    expect(linkingPage?.content).toContain("[Target Page](/wiki/target-page)");
    expect(linkingPage?.content).toContain("[display label](/wiki/target-page)");
    expect(linkingPage?.content).toContain("[[Missing Page|missing label]]");
    expect(linkingPage?.content).toContain("`[[Target Page|inline label]]`");
    expect(linkingPage?.content).toContain("[[Target Page|fenced label]]");
    expect(store.getForwardLinks(linkingPage!.id).map((page) => page.id)).toContain(targetPage!.id);
  });
});
