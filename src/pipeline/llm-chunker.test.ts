import { expect, test, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { Store } from "../store";
import { LLMClient } from "../llm-client";
import { llmChunkDocument, htmlToRawText } from "./llm-chunker";
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
});
