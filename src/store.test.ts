import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Store } from "./store";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
  });

  afterEach(() => {
    store.close();
  });

  test("addSource and listSources", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test PDF", "raw content");
    expect(src.id).toBeGreaterThan(0);
    expect(src.uri).toBe("file:///test.pdf");
    expect(src.type).toBe("pdf");
    expect(src.title).toBe("Test PDF");

    const sources = store.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].uri).toBe("file:///test.pdf");
  });

  test("addSource updates existing source with same URI", () => {
    const src1 = store.addSource("file:///test.pdf", "pdf", "V1", "content1");
    const src2 = store.addSource("file:///test.pdf", "pdf", "V2", "content2");
    expect(src2.id).toBe(src1.id);
    expect(src2.title).toBe("V2");
    expect(src2.raw_content).toBe("content2");
    expect(store.listSources()).toHaveLength(1);
  });

  test("addPage and getPage by slug", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    const page = store.addPage("test-page", "Test Page", "# Content", src.id, null, "source", 0);
    expect(page.slug).toBe("test-page");
    expect(page.title).toBe("Test Page");
    expect(page.page_type).toBe("source");

    const fetched = store.getPage("test-page");
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Test Page");

    expect(store.getPage("nonexistent")).toBeNull();
  });

  test("listSourcePages and listConceptPages", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    store.addPage("src-page", "Source Page", "content", src.id, null, "source", 0);
    store.addPage("concept-page", "Concept Page", "content", undefined, undefined, "concept", 0);

    const sourcePages = store.listSourcePages();
    expect(sourcePages).toHaveLength(1);
    expect(sourcePages[0].slug).toBe("src-page");

    const conceptPages = store.listConceptPages();
    expect(conceptPages).toHaveLength(1);
    expect(conceptPages[0].slug).toBe("concept-page");
  });

  test("addLink and getBacklinks", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    const pageA = store.addPage("page-a", "Page A", "content", src.id, null, "source", 0);
    const pageB = store.addPage("page-b", "Page B", "content", src.id, null, "source", 1);

    store.addLink(pageA.id, pageB.id, "link to B");

    const backlinks = store.getBacklinks(pageB.id);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].slug).toBe("page-a");
  });

  test("getAllBacklinksGrouped", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    const pageA = store.addPage("page-a", "Page A", "content", src.id, null, "source", 0);
    const pageB = store.addPage("page-b", "Page B", "content", src.id, null, "source", 1);
    const pageC = store.addPage("page-c", "Page C", "content", src.id, null, "source", 2);

    store.addLink(pageA.id, pageC.id, "link to C from A");
    store.addLink(pageB.id, pageC.id, "link to C from B");

    const grouped = store.getAllBacklinksGrouped();
    expect(grouped.has(pageC.id)).toBe(true);
    expect(grouped.get(pageC.id)!).toHaveLength(2);
  });

  test("deletePagesBySource", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    store.addPage("page-1", "Page 1", "content", src.id, null, "source", 0);
    store.addPage("page-2", "Page 2", "content", src.id, null, "source", 1);
    expect(store.listPages()).toHaveLength(2);

    store.deletePagesBySource(src.id);
    expect(store.listPages()).toHaveLength(0);
  });

  test("slug uniqueness (duplicate handling via INSERT OR REPLACE)", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    store.addPage("same-slug", "Title V1", "content v1", src.id, null, "source", 0);
    store.addPage("same-slug", "Title V2", "content v2", src.id, null, "source", 0);

    const page = store.getPage("same-slug");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Title V2");
    expect(page!.content).toBe("content v2");
  });

  test("listSourcesMeta excludes raw_content", () => {
    store.addSource("file:///test.pdf", "pdf", "Test", "some large raw content here");
    const meta = store.listSourcesMeta();
    expect(meta).toHaveLength(1);
    expect(meta[0].title).toBe("Test");
    expect(meta[0]).not.toHaveProperty("raw_content");
  });

  test("addUsageLog and getUsageSummary", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    store.addUsageLog(src.id, 2, 100, 50, 150, 0.005);
    store.addUsageLog(src.id, 3, 200, 100, 300, 0.01);

    const summary = store.getUsageSummary();
    expect(summary.totalCalls).toBe(5);
    expect(summary.promptTokens).toBe(300);
    expect(summary.completionTokens).toBe(150);
    expect(summary.totalTokens).toBe(450);
    expect(summary.totalCost).toBeCloseTo(0.015, 5);
  });
});
