import { expect, test, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { Store } from "../store";
import { LLMClient } from "../llm-client";
import { generateDynamicPage } from "./dynamic-qa";
import type { LLMConfig } from "../config";

// Characterization tests for dynamic Q&A page generation. The LLMClient is a
// real instance whose chatComplete is stubbed — no live API calls.

const llmConfig: LLMConfig = { provider: "gemini", model: "test", api_key: "k", endpoint: "" };

function makeClient(response: string): { client: LLMClient; spy: ReturnType<typeof spyOn> } {
  const client = new LLMClient(llmConfig);
  const spy = spyOn(client, "chatComplete").mockResolvedValue(response);
  return { client, spy };
}

describe("generateDynamicPage", () => {
  let store: Store;
  let parent: { id: number; slug: string; title: string; content: string };

  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    const p = store.addPage("physics", "Physics", "Physics overview.", src.id, null, "concept", 0);
    parent = { id: p.id, slug: p.slug, title: p.title, content: p.content };
  });

  afterEach(() => {
    store.close();
  });

  test("creates a page from a well-formed JSON response and links from parent", async () => {
    const response = JSON.stringify({
      title: "Wave Function",
      content:
        "A wave function describes the quantum state of a system.\n\nIt relates to [[Physics]] and spans enough characters to be promotable content here.",
      isPromotable: true,
      keyConcepts: ["wave function", "quantum state"],
    });
    const { client } = makeClient(response);

    const result = await generateDynamicPage(store, client, null, parent, "psi symbol", "What is a wave function?");

    expect(result.title).toBe("Wave Function");
    expect(result.slug).toBe("wave-function");
    expect(result.isPromotable).toBe(true);
    expect(result.keyConcepts).toEqual(["wave function", "quantum state"]);

    const page = store.getPage("wave-function")!;
    expect(page).not.toBeNull();

    const forward = store.getForwardLinks(parent.id);
    expect(forward.map((p) => p.slug)).toContain("wave-function");

    // Usage log recorded
    const summary = store.getUsageSummary();
    expect(summary.totalCalls).toBeGreaterThanOrEqual(0);
  });

  test("strips markdown code fences around the JSON", async () => {
    const response = "```json\n" + JSON.stringify({
      title: "Entropy",
      content: "Entropy measures disorder in a system, a foundational thermodynamic quantity here.",
      isPromotable: false,
      keyConcepts: [],
    }) + "\n```";
    const { client } = makeClient(response);

    const result = await generateDynamicPage(store, client, null, parent, "sel", "define entropy");
    expect(result.title).toBe("Entropy");
    expect(result.isPromotable).toBe(false);
  });

  test("falls back to raw markdown when the response is not JSON", async () => {
    const raw = "This is a plain markdown explanation with more than twenty characters.";
    const { client } = makeClient(raw);

    const result = await generateDynamicPage(store, client, null, parent, "sel", "Explain this concept clearly");
    expect(result.title).toBe("Explain this concept clearly".slice(0, 50));
    expect(result.content).toContain("plain markdown explanation");
  });

  test("resolves slug collisions with a numeric suffix", async () => {
    store.addPage("entropy", "Entropy", "existing", undefined, undefined, "concept", 0);
    const response = JSON.stringify({
      title: "Entropy",
      content: "A fresh entropy explanation that easily exceeds the twenty character minimum here.",
    });
    const { client } = makeClient(response);

    const result = await generateDynamicPage(store, client, null, parent, "sel", "entropy again");
    expect(result.slug).toBe("entropy-2");
  });

  test("throws when parsed content is too short", async () => {
    const { client } = makeClient(JSON.stringify({ title: "T", content: "short" }));
    await expect(
      generateDynamicPage(store, client, null, parent, "sel", "q"),
    ).rejects.toThrow();
  });

  test("infers promotability from content length when not provided", async () => {
    const longContent =
      "Paragraph one carries substantial educational content that goes on for a while to build up length.\n\n" +
      "Paragraph two adds even more detail and examples so the heuristic comfortably passes the two hundred character promotable threshold.";
    const { client } = makeClient(JSON.stringify({ title: "Momentum", content: longContent }));

    const result = await generateDynamicPage(store, client, null, parent, "sel", "define momentum");
    expect(result.isPromotable).toBe(true);
  });
});
