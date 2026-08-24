import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("schema: pages table has all migrated columns on a fresh DB", () => {
    // Guards against CREATE TABLE / ALTER TABLE drift: every column added
    // via the migration block must also exist after a fresh init, otherwise
    // an index that references it (or downstream code) will break.
    const db = (store as any).db;
    const cols = db.query("PRAGMA table_info(pages)").all().map((r: any) => r.name);
    for (const required of ["origin", "manual_revision", "user_question", "parent_page_id", "category"]) {
      expect(cols).toContain(required);
    }
    const checkpointColumns = db.query("PRAGMA table_info(pipeline_checkpoints)").all().map((r: any) => r.name);
    expect(checkpointColumns).toContain("input_hash");
  });

  test("adds missing legacy columns before creating indexes that depend on them", () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-legacy-schema-"));
    const dbPath = join(root, "kiwi.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uri TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        title TEXT,
        raw_content TEXT,
        fetched_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_id INTEGER,
        section_anchor TEXT,
        page_type TEXT NOT NULL DEFAULT 'concept',
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE quizzes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        quiz_type TEXT NOT NULL DEFAULT 'fill_blank',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE pipeline_checkpoints (
        source_id INTEGER NOT NULL,
        phase TEXT NOT NULL,
        batch_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (source_id, phase, batch_index)
      );
    `);
    legacy.close();

    const migrated = new Store(dbPath);
    try {
      const db = (migrated as any).db;
      const columns = (table: string) => db.prepare(`PRAGMA table_info("${table}")`)
        .all().map((row: any) => row.name);
      expect(columns("pages")).toEqual(expect.arrayContaining([
        "origin",
        "manual_revision",
        "user_question",
        "parent_page_id",
        "category",
      ]));
      expect(columns("sources")).toContain("content_hash");
      expect(columns("pipeline_checkpoints")).toContain("input_hash");
      expect(columns("quizzes")).toEqual(expect.arrayContaining([
        "explanation",
        "ease_factor",
        "interval",
        "next_review_at",
      ]));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("idx_pages_category")).toEqual({ name: "idx_pages_category" });
      expect(db.prepare("SELECT dflt_value FROM pragma_table_info('pages') WHERE name = ?")
        .get("manual_revision")).toEqual({ dflt_value: "0" });
    } finally {
      migrated.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("propagates an additive migration failure and rolls back earlier columns", () => {
    const db = (store as any).db;
    db.exec(`
      DROP INDEX idx_pages_parent;
      DROP INDEX idx_pages_category;
      ALTER TABLE pages DROP COLUMN parent_page_id;
      ALTER TABLE pages DROP COLUMN category;
    `);
    const originalExec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql.includes('ADD COLUMN "category"')) throw new Error("simulated ALTER failure");
      return originalExec(sql);
    };

    try {
      expect(() => store.initSchema()).toThrow("simulated ALTER failure");
    } finally {
      db.exec = originalExec;
    }

    const afterFailure = db.prepare('PRAGMA table_info("pages")').all().map((row: any) => row.name);
    expect(afterFailure).not.toContain("parent_page_id");
    expect(afterFailure).not.toContain("category");

    store.initSchema();
  });

  test("does not mistake an actual SQLite ALTER error for an applied migration", () => {
    const db = (store as any).db;
    db.exec(`
      DROP INDEX idx_pages_category;
      ALTER TABLE pages DROP COLUMN category;
      PRAGMA query_only=ON;
    `);
    try {
      expect(() => store.initSchema()).toThrow("attempt to write a readonly database");
    } finally {
      db.exec("PRAGMA query_only=OFF");
      store.initSchema();
    }
  });

  test("tightens persistent database and WAL sidecars to owner-only", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "kiwimu-store-mode-"));
    const dbPath = join(root, "kiwi.db");
    const persistent = new Store(dbPath);
    try {
      chmodSync(dbPath, 0o644);
    } finally {
      persistent.close();
    }

    const reopened = new Store(dbPath);
    try {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        expect(statSync(`${dbPath}${suffix}`).mode & 0o777).toBe(0o600);
      }
    } finally {
      reopened.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to follow a persistent database symlink", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "kiwimu-store-symlink-"));
    const outside = join(root, "outside.db");
    const dbPath = join(root, "kiwi.db");
    writeFileSync(outside, "not a database", { mode: 0o644 });
    chmodSync(outside, 0o644);
    symlinkSync(outside, dbPath);
    try {
      expect(() => new Store(dbPath)).toThrow();
      expect(statSync(outside).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("updates page content and citation records atomically", () => {
    const source = store.addSource("file:///citation.pdf", "pdf", "Citation", "raw");
    const sourcePage = store.addPage("citation-source", "Citation source", "source", source.id);
    const page = store.addPage("citation-target", "Citation target", "before");
    store.addCitation(page.id, source.id, sourcePage.id, "excerpt", "context");

    const fence = store.activateContentFence({
      resource: "content",
      ownerToken: "page-editor",
      fencingToken: 1,
    });
    store.runWithContentFence(fence, () => {
      store.updatePageContentAndCitationsBySlug(page.slug, "after", []);
    });
    expect(store.getPage(page.slug)?.content).toBe("after");
    expect(store.getCitationsForPage(page.id)).toEqual([]);

    store.updatePageContentAndCitationsBySlug(page.slug, "restored", [{
      sourceId: source.id,
      sourcePageId: sourcePage.id,
      excerpt: "excerpt",
      context: "context",
    }]);
    expect(store.getPage(page.slug)?.content).toBe("restored");
    expect(store.getCitationsForPage(page.id)[0]).toMatchObject({
      source_id: source.id,
      source_page_id: sourcePage.id,
      excerpt: "excerpt",
      context: "context",
    });
  });

  test("marks only real administrator edits to generated batch pages", () => {
    const source = store.addSource("file:///manual-revision.md", "md", "Manual", "raw");
    const batchPage = store.addPage("batch-edit", "Batch", "generated", source.id);
    const pipelinePage = store.addPage("pipeline-edit", "Pipeline", "generated", source.id);
    const userPageId = store.addDynamicPage(
      "promoted-edit", "Promoted", "user content", batchPage.id, "question",
    );

    store.updatePageContentAsManualEdit(batchPage.id, "administrator v1");
    store.updatePageContentAsManualEdit(batchPage.id, "administrator v2");
    store.updatePageContentAsManualEdit(batchPage.id, "administrator v2");
    store.updatePageContentAsManualEdit(userPageId, "user revision");
    store.updatePageContent(pipelinePage.id, "pipeline revision");

    expect(store.getPage(batchPage.slug)).toMatchObject({
      content: "administrator v2",
      origin: "batch",
      manual_revision: 2,
    });
    expect(store.getPageById(userPageId)).toMatchObject({
      content: "user revision",
      origin: "user",
      manual_revision: 0,
    });
    expect(store.getPage(pipelinePage.slug)).toMatchObject({
      content: "pipeline revision",
      origin: "batch",
      manual_revision: 0,
    });
  });

  test("keeps a dynamic page and its parent link absent after fence replacement", () => {
    const parent = store.addPage("fenced-parent", "Parent", "content");
    const staleFence = store.activateContentFence({
      resource: "content",
      ownerToken: "stale-worker",
      fencingToken: 1,
    });
    store.activateContentFence({
      resource: "content",
      ownerToken: "replacement-worker",
      fencingToken: 2,
    });

    expect(() => store.runWithContentFence(staleFence, () => {
      store.addDynamicPageWithParentLink(
        "stale-answer",
        "Stale answer",
        "This content must never commit after the fence is replaced.",
        parent.id,
        "question",
      );
    })).toThrow("stale or no longer owned");

    expect(store.getPage("stale-answer")).toBeNull();
    expect(store.getForwardLinks(parent.id)).toEqual([]);
  });

  test("rolls back a dynamic page when its parent link cannot be inserted", () => {
    expect(() => store.addDynamicPageWithParentLink(
      "orphan-answer",
      "Orphan answer",
      "The page insert must roll back if the required parent link fails.",
      999_999,
      "question",
    )).toThrow();

    expect(store.getPage("orphan-answer")).toBeNull();
    expect(store.getAllLinks()).toEqual([]);
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
    const page = store.addPage("test-page", "Test Page", "# Content", src.id, undefined, "source", 0);
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
    store.addPage("src-page", "Source Page", "content", src.id, undefined, "source", 0);
    store.addPage("concept-page", "Concept Page", "content", undefined, undefined, "concept", 0);

    const sourcePages = store.listSourcePages();
    expect(sourcePages).toHaveLength(1);
    expect(sourcePages[0].slug).toBe("src-page");

    const conceptPages = store.listConceptPages();
    expect(conceptPages).toHaveLength(1);
    expect(conceptPages[0].slug).toBe("concept-page");
    expect(store.countPagesByType("source")).toBe(1);
    expect(store.countPagesByType("concept")).toBe(1);
  });

  test("content index revision changes for index-affecting mutations only", () => {
    const initial = store.getContentIndexRevision();
    const src = store.addSource("file:///revision.pdf", "pdf", "Revision", "raw");
    const pageA = store.addPage("revision-a", "A", "content", src.id, undefined, "source", 0);
    const pageB = store.addPage("revision-b", "B", "content", src.id, undefined, "concept", 0);
    const afterPages = store.getContentIndexRevision();
    expect(afterPages).toBeGreaterThan(initial);

    store.updatePageContent(pageA.id, "changed body only");
    expect(store.getContentIndexRevision()).toBe(afterPages);

    store.addLink(pageA.id, pageB.id, "B");
    const afterLink = store.getContentIndexRevision();
    expect(afterLink).toBeGreaterThan(afterPages);
    store.addLink(pageA.id, pageB.id, "B");
    expect(store.getContentIndexRevision()).toBe(afterLink);
  });

  test("addLink and getBacklinks", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    const pageA = store.addPage("page-a", "Page A", "content", src.id, undefined, "source", 0);
    const pageB = store.addPage("page-b", "Page B", "content", src.id, undefined, "source", 1);

    store.addLink(pageA.id, pageB.id, "link to B");

    const backlinks = store.getBacklinks(pageB.id);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].slug).toBe("page-a");
  });

  test("getAllBacklinksGrouped", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    const pageA = store.addPage("page-a", "Page A", "content", src.id, undefined, "source", 0);
    const pageB = store.addPage("page-b", "Page B", "content", src.id, undefined, "source", 1);
    const pageC = store.addPage("page-c", "Page C", "content", src.id, undefined, "source", 2);

    store.addLink(pageA.id, pageC.id, "link to C from A");
    store.addLink(pageB.id, pageC.id, "link to C from B");

    const grouped = store.getAllBacklinksGrouped();
    expect(grouped.has(pageC.id)).toBe(true);
    expect(grouped.get(pageC.id)!).toHaveLength(2);
  });

  test("deletePagesBySource", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    store.addPage("page-1", "Page 1", "content", src.id, undefined, "source", 0);
    store.addPage("page-2", "Page 2", "content", src.id, undefined, "source", 1);
    expect(store.listPages()).toHaveLength(2);

    store.deletePagesBySource(src.id);
    expect(store.listPages()).toHaveLength(0);
  });

  test("slug uniqueness (duplicate handling via INSERT OR REPLACE)", () => {
    const src = store.addSource("file:///test.pdf", "pdf", "Test", "raw");
    store.addPage("same-slug", "Title V1", "content v1", src.id, undefined, "source", 0);
    store.addPage("same-slug", "Title V2", "content v2", src.id, undefined, "source", 0);

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

  test("does not rebuild an already consistent FTS index during schema initialization", () => {
    store.addPage("fts-consistent", "FTS Consistent", "searchable content");
    const db = (store as any).db;
    const before = (db.prepare("SELECT total_changes() as changes").get() as { changes: number }).changes;

    store.initSchema();

    const after = (db.prepare("SELECT total_changes() as changes").get() as { changes: number }).changes;
    expect(after).toBe(before);
  });

  test("rebuilds an empty legacy FTS index when its indexed row count mismatches pages", () => {
    store.addPage("fts-legacy", "Legacy Search", "legacy searchable content");
    const db = (store as any).db;
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('delete-all')");
    expect(db.prepare("SELECT COUNT(*) as count FROM pages_fts_docsize").get()).toEqual({ count: 0 });

    store.initSchema();

    expect(store.searchPages("searchable", 5).map((page) => page.slug)).toContain("fts-legacy");
  });

  test("falls back to LIKE when FTS has no Korean substring match", () => {
    store.addPage("korean-search", "한국사", "대한민국의 수도는 서울입니다");

    const results = store.searchPages("한민국", 5);

    expect(results.map((page) => page.slug)).toContain("korean-search");
    expect(results[0].rank).toBe(0);
  });

  test("lists distinct figure paths without loading figure metadata", () => {
    const source = store.addSource("file:///figures.pdf", "pdf", "Figures", "raw");
    store.addFigure(source.id, "/static/figures/src1-001.png", undefined, "caption", 1);
    store.addFigure(source.id, "/static/figures/src1-001.png", undefined, "duplicate", 2);
    store.addFigure(source.id, "/static/figures/src1-002.png", undefined, "caption", 3);

    expect(store.listFigurePaths()).toEqual([
      "/static/figures/src1-001.png",
      "/static/figures/src1-002.png",
    ]);
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

  test("deleteAllSources preserves usage accounting and clears checkpoints", () => {
    const src = store.addSource("file:///reset.pdf", "pdf", "Reset", "raw");
    store.addPage("reset-page", "Reset Page", "content", src.id, undefined, "source");
    store.setCheckpoint(src.id, "phase1_chunk", 0);
    store.addUsageLog(src.id, 2, 100, 50, 150, 0.005);

    store.deleteAllSources();

    expect(store.countSources()).toBe(0);
    expect(store.countPages()).toBe(0);
    expect(store.hasCheckpoints(src.id)).toBe(false);
    expect(store.getUsageSummary()).toEqual({
      totalCalls: 2,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      totalCost: 0.005,
    });
    const usageRows = (store as any).db.prepare("SELECT source_id FROM usage_logs").all();
    expect(usageRows).toEqual([{ source_id: null }]);
  });

  test("deleteAllSources rolls every deletion back when source deletion fails", () => {
    const src = store.addSource("file:///rollback.pdf", "pdf", "Rollback", "raw");
    store.addPage("rollback-page", "Rollback Page", "content", src.id, undefined, "source");
    store.setCheckpoint(src.id, "phase1_chunk", 0);
    store.addUsageLog(src.id, 1, 10, 5, 15, 0.001);
    const db = (store as any).db;
    db.exec(`CREATE TRIGGER fail_source_reset BEFORE DELETE ON sources BEGIN
      SELECT RAISE(ABORT, 'injected source deletion failure');
    END`);

    expect(() => store.deleteAllSources()).toThrow("injected source deletion failure");

    expect(store.countSources()).toBe(1);
    expect(store.countPages()).toBe(1);
    expect(store.hasCheckpoints(src.id)).toBe(true);
    expect(db.prepare("SELECT source_id FROM usage_logs").get()).toEqual({ source_id: src.id });
  });
});
