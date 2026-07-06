import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Store } from "../store";

// Store-level building blocks for incremental re-ingest (content-hash change
// detection + per-source page counting). The full ingest gate (shouldSkipUnchanged)
// composes exactly these; the LLM pipeline itself is covered by fixtures elsewhere.
describe("incremental re-ingest store support", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
  });
  afterEach(() => store.close());

  test("sources table has content_hash column after migration", () => {
    const db = (store as any).db;
    const cols = db.query("PRAGMA table_info(sources)").all().map((r: any) => r.name);
    expect(cols).toContain("content_hash");
  });

  test("getSourceHash is null before any ingest, roundtrips after set", () => {
    const src = store.addSource("file:///a.pdf", "pdf", "A", "(file)");
    expect(store.getSourceHash("file:///a.pdf")).toBeNull();

    store.setSourceHash(src.id, "deadbeef");
    expect(store.getSourceHash("file:///a.pdf")).toBe("deadbeef");
  });

  test("re-adding an existing URI preserves the id and its stored hash", () => {
    const src = store.addSource("file:///a.pdf", "pdf", "A", "(file)");
    store.setSourceHash(src.id, "hash-v1");

    const again = store.addSource("file:///a.pdf", "pdf", "A (updated title)", "(file)");
    expect(again.id).toBe(src.id);
    // addSource does not clear the hash; the ingest flow updates it only on success
    expect(store.getSourceHash("file:///a.pdf")).toBe("hash-v1");
  });

  test("countPagesBySource reflects only that source's pages", () => {
    const a = store.addSource("file:///a.pdf", "pdf", "A", "(file)");
    const b = store.addSource("file:///b.pdf", "pdf", "B", "(file)");
    expect(store.countPagesBySource(a.id)).toBe(0);

    store.addPage("a-1", "A1", "body", a.id, undefined, "source", 0);
    store.addPage("a-2", "A2", "body", a.id, undefined, "concept", 0);
    store.addPage("b-1", "B1", "body", b.id, undefined, "source", 0);

    expect(store.countPagesBySource(a.id)).toBe(2);
    expect(store.countPagesBySource(b.id)).toBe(1);
  });

  test("unchanged decision: same hash + existing pages ⇒ skip is possible", () => {
    // Mirrors shouldSkipUnchanged: existing source, matching hash, pages present.
    const src = store.addSource("file:///a.pdf", "pdf", "A", "(file)");
    store.addPage("a-1", "A1", "body", src.id, undefined, "source", 0);
    store.setSourceHash(src.id, "same");

    const wouldSkip =
      store.getSource("file:///a.pdf") !== null &&
      store.getSourceHash("file:///a.pdf") === "same" &&
      store.countPagesBySource(src.id) > 0;
    expect(wouldSkip).toBe(true);

    // Different content hash ⇒ must NOT skip (re-ingest).
    const wouldSkipChanged = store.getSourceHash("file:///a.pdf") === "different";
    expect(wouldSkipChanged).toBe(false);
  });
});
