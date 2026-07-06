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
    store.addPage("energy", "Energy", "Energy is conserved.", src.id, null, "concept", 0);
    const a = store.addPage(
      "thermo",
      "Thermodynamics",
      "This field studies Energy in detail.",
      src.id,
      null,
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
    store.addPage("energy", "Energy", "Energy references Energy again.", src.id, null, "concept", 0);
    expect(autoLinkPages(store)).toBe(0);
    expect(store.getPage("energy")!.content).toBe("Energy references Energy again.");
  });

  test("skips titles shorter than 3 chars", () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    store.addPage("ab", "AB", "content", src.id, null, "concept", 0);
    store.addPage("other", "Other", "mentions AB here", src.id, null, "concept", 1);
    expect(autoLinkPages(store)).toBe(0);
  });

  test("links each target at most once per page", () => {
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    store.addPage("energy", "Energy", "def", src.id, null, "concept", 0);
    store.addPage("doc", "Doc", "Energy then Energy then Energy.", src.id, null, "concept", 1);

    expect(autoLinkPages(store)).toBe(1);
    const content = store.getPage("doc")!.content;
    expect(content.match(/\/wiki\/energy/g)).toHaveLength(1);
  });

  test("re-running is NOT idempotent: it re-matches the slug inside the emitted URL", () => {
    // Characterization of a known limitation — the title "Energy" also matches
    // the slug text in "/wiki/energy", so a second pass finds a match again.
    const src = store.addSource("file:///t.pdf", "pdf", "T", "raw");
    store.addPage("energy", "Energy", "def", src.id, null, "concept", 0);
    store.addPage("doc", "Doc", "About Energy.", src.id, null, "concept", 1);

    expect(autoLinkPages(store)).toBe(1);
    // Second run still returns 1 because "energy" appears inside the URL.
    expect(autoLinkPages(store)).toBe(1);
  });
});
