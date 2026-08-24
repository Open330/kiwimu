import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Store } from "../store";
import { autoLinkPages } from "./linker";

// Characterization tests for auto wiki-linking across stored pages.

describe("autoLinkPages", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
  });

  afterEach(() => {
    store.close();
  });

  test("returns 0 when there are no pages", () => {
    expect(autoLinkPages(store)).toBe(0);
  });

  test("links a page whose body mentions another page's title", () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    store.addPage("energy", "Energy", "Energy is conserved.", src.id, undefined, "concept", 0);
    const a = store.addPage(
      "thermo",
      "Thermodynamics",
      "This field studies Energy in detail.",
      src.id,
      undefined,
      "concept",
      1,
    );

    const total = autoLinkPages(store);
    expect(total).toBe(1);

    const updated = store.getPage("thermo")!;
    expect(updated.content).toContain("[Energy](/wiki/energy)");

    const backlinks = store.getBacklinks(store.getPage("energy")!.id);
    expect(backlinks.map((p) => p.slug)).toContain("thermo");
    // linker id unused
    void a;
  });

  test("does not link a page to itself", () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    store.addPage("energy", "Energy", "Energy references Energy again.", src.id, undefined, "concept", 0);
    expect(autoLinkPages(store)).toBe(0);
    expect(store.getPage("energy")!.content).toBe("Energy references Energy again.");
  });

  test("skips titles shorter than 3 chars", () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    store.addPage("ab", "AB", "content", src.id, undefined, "concept", 0);
    store.addPage("other", "Other", "mentions AB here", src.id, undefined, "concept", 1);
    expect(autoLinkPages(store)).toBe(0);
  });

  test("links each target at most once per page", () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    store.addPage("energy", "Energy", "def", src.id, undefined, "concept", 0);
    store.addPage("doc", "Doc", "Energy then Energy then Energy.", src.id, undefined, "concept", 1);

    expect(autoLinkPages(store)).toBe(1);
    const content = store.getPage("doc")!.content;
    expect(content.match(/\/wiki\/energy/g)).toHaveLength(1);
  });

  test("re-running keeps generated Markdown and backlinks idempotent", () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    store.addPage("energy", "Energy", "def", src.id, undefined, "concept", 0);
    store.addPage("doc", "Doc", "About Energy.", src.id, undefined, "concept", 1);

    expect(autoLinkPages(store)).toBe(1);
    const firstContent = store.getPage("doc")!.content;
    expect(autoLinkPages(store)).toBe(1);
    expect(store.getPage("doc")!.content).toBe(firstContent);
    expect(firstContent).toBe("About [Energy](/wiki/energy).");
    expect(store.getBacklinks(store.getPage("energy")!.id).map((page) => page.slug)).toEqual(["doc"]);
  });

  test("does not rewrite existing links, images, code, raw URLs, or HTML anchors", () => {
    const src = store.addSource("file:///protected.md", "md", "Protected", "raw");
    store.addPage("energy", "Energy", "def", src.id, undefined, "concept", 0);
    store.addPage(
      "doc",
      "Doc",
      [
        "[Energy](https://example.com)",
        "![Energy](/image.png)",
        "`Energy`",
        "``Energy with ` inside``",
        "```txt\nEnergy\n```",
        "~~~~txt\nEnergy\n~~~~",
        "````md\n```txt\nEnergy\n```\n````",
        "https://example.com/Energy",
        '<a href="/custom">Energy</a>',
        "Plain Energy.",
        "```unclosed\nEnergy",
      ].join("\n"),
      src.id,
      undefined,
      "concept",
      1,
    );

    expect(autoLinkPages(store)).toBe(1);
    expect(store.getPage("doc")!.content).toBe([
      "[Energy](https://example.com)",
      "![Energy](/image.png)",
      "`Energy`",
      "``Energy with ` inside``",
      "```txt\nEnergy\n```",
      "~~~~txt\nEnergy\n~~~~",
      "````md\n```txt\nEnergy\n```\n````",
      "https://example.com/Energy",
      '<a href="/custom">Energy</a>',
      "Plain [Energy](/wiki/energy).",
      "```unclosed\nEnergy",
    ].join("\n"));
  });

  test("longest titles win without relinking inside the generated destination", () => {
    const src = store.addSource("file:///longest.md", "md", "Longest", "raw");
    store.addPage("energy", "Energy", "def", src.id, undefined, "concept", 0);
    store.addPage("energy-storage", "Energy Storage", "def", src.id, undefined, "concept", 1);
    store.addPage("doc", "Doc", "Energy Storage uses Energy.", src.id, undefined, "concept", 2);

    expect(autoLinkPages(store)).toBe(2);
    expect(store.getPage("doc")!.content).toBe(
      "[Energy Storage](/wiki/energy-storage) uses [Energy](/wiki/energy).",
    );
  });
});
