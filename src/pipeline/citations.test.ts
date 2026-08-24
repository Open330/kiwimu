import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Store } from "../store";
import { parseCitations, renderCitationFootnotes } from "./citations";

// Characterization tests for [^src:SLUG] citation parsing and footnote rendering.

describe("parseCitations", () => {
  let store: Store;
  let sourceId: number;

  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
    const src = store.addSource("file:///t.pdf", "pdf", "Textbook", "raw");
    sourceId = src.id;
    // Two source pages that markers can reference (must carry source_id)
    store.addPage("chapter-1", "Chapter 1", "c1", sourceId, "chapter-1", "source", 0);
    store.addPage("chapter-2", "Chapter 2", "c2", sourceId, "chapter-2", "source", 1);
  });

  afterEach(() => {
    store.close();
  });

  test("replaces a valid marker with a numbered footnote ref and records a citation", () => {
    const page = store.addPage("concept", "Concept", "placeholder", undefined, undefined, "concept", 0);
    const body = "Energy is conserved [^src:chapter-1].";
    const result = parseCitations(body, page.id, store);

    expect(result).toContain('class="citation-ref"');
    expect(result).toContain('href="#cite-1"');
    expect(result).not.toContain("[^src:chapter-1]");

    const citations = store.getCitationsForPage(page.id);
    expect(citations).toHaveLength(1);
    expect(citations[0].source_page_id).toBe(store.getPage("chapter-1")!.id);
  });

  test("numbers distinct sources sequentially", () => {
    const page = store.addPage("c2p", "C2P", "x", undefined, undefined, "concept", 0);
    const body = "A [^src:chapter-1] and B [^src:chapter-2].";
    const result = parseCitations(body, page.id, store);

    expect(result).toContain('A <sup class="citation-ref"><a href="#cite-1"');
    expect(result).toContain('B <sup class="citation-ref"><a href="#cite-2"');
    expect(store.getCitationsForPage(page.id).map((citation) => citation.source_page_slug)).toEqual([
      "chapter-1",
      "chapter-2",
    ]);
  });

  test("keeps an invalid marker visible and records nothing", () => {
    const page = store.addPage("c3", "C3", "x", undefined, undefined, "concept", 0);
    const body = "Claim [^src:does-not-exist] here.";
    const result = parseCitations(body, page.id, store);

    expect(result).toBe(body);
    expect(store.getCitationsForPage(page.id)).toHaveLength(0);
  });

  test("supports Unicode and underscore slugs", () => {
    store.addPage("क्वांटम_기초", "Quantum 기초", "source", sourceId, "क्वांटम_기초", "source", 2);
    const page = store.addPage("unicode-citation", "Unicode", "x");

    const result = parseCitations("Claim [^src:क्वांटम_기초].", page.id, store);

    expect(result).toContain('href="#cite-1"');
    expect(store.getCitationsForPage(page.id)[0].source_page_slug).toBe("क्वांटम_기초");
  });

  test("does not turn citation examples in code into provenance", () => {
    const page = store.addPage("citation-guide", "Citation guide", "x");
    const body = [
      "Inline `[^src:chapter-1]`.",
      "",
      "```md",
      "[^src:chapter-2]",
      "```",
    ].join("\n");

    expect(parseCitations(body, page.id, store)).toBe(body);
    expect(store.getCitationsForPage(page.id)).toEqual([]);
  });

  test("returns body unchanged when there are no markers", () => {
    const page = store.addPage("c4", "C4", "x", undefined, undefined, "concept", 0);
    store.addCitation(page.id, sourceId, store.getPage("chapter-1")!.id);
    const body = "No citations at all.";
    expect(parseCitations(body, page.id, store)).toBe(body);
    expect(store.getCitationsForPage(page.id)).toEqual([]);
  });

  test("re-parsing deletes prior citations to avoid duplicates", () => {
    const page = store.addPage("c5", "C5", "x", undefined, undefined, "concept", 0);
    const body = "Fact [^src:chapter-1].";
    parseCitations(body, page.id, store);
    parseCitations(body, page.id, store);
    expect(store.getCitationsForPage(page.id)).toHaveLength(1);
  });
});

describe("renderCitationFootnotes", () => {
  test("returns empty string with no citations", () => {
    expect(renderCitationFootnotes([])).toBe("");
  });

  test("renders a Sources section deduplicated by source page", () => {
    const citations = [
      {
        id: 1,
        page_id: 10,
        source_id: 1,
        source_page_id: 5,
        excerpt: "an excerpt",
        context: null,
        created_at: "now",
        source_page_title: "Chapter 1",
        source_page_slug: "chapter-1",
      },
      {
        id: 2,
        page_id: 10,
        source_id: 1,
        source_page_id: 5,
        excerpt: null,
        context: null,
        created_at: "now",
        source_page_title: "Chapter 1",
        source_page_slug: "chapter-1",
      },
    ];
    const html = renderCitationFootnotes(citations);
    expect(html).toContain('class="citations-section"');
    expect(html).toContain("Sources");
    expect(html).toContain('id="cite-1"');
    // deduped by source_page_id -> only one item
    expect(html).not.toContain('id="cite-2"');
    expect(html).toContain('href="/wiki/chapter-1.html"');
    expect(html).toContain("an excerpt");
  });
});
