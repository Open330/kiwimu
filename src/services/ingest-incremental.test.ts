import { expect, test, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IngestManualEditConflictError, Store } from "../store";
import {
  cleanupAbandonedIngestStaging,
  cleanupIngestStaging,
  copyStagedFiguresForCandidate,
  createIngestGenerationFingerprint,
  ingestFigurePrefix,
  openIngestStaging,
  prepareIngestFigureStaging,
  publishStagedFigures,
} from "./ingest-staging";
import { ingestFile, prepareIngestAttempt } from "./ingest";
import { LLMClient } from "../llm-client";

const TEST_LLM = { provider: "gemini", model: "test", api_key: "secret", endpoint: "" };
const TEST_FINGERPRINT = createIngestGenerationFingerprint(TEST_LLM, null, undefined, {
  sourceType: "md",
  title: "test",
  extractFigures: false,
});

function withFence<T>(store: Store, token: number, operation: () => T): T {
  const fence = store.activateContentFence({
    resource: "content-mutation",
    ownerToken: `owner-${token}`,
    fencingToken: token,
  });
  return store.runWithContentFence(fence, operation);
}

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

describe("generation-staged re-ingest", () => {
  test("keeps foreign corpus bodies out of staging snapshots and search index", () => {
    const live = new Store(":memory:");
    const staging = new Store(":memory:");
    try {
      const target = live.addSource("file:///target.md", "md", "Target", "old target raw");
      live.addPage("old-target", "Old target", "old generated body", target.id, undefined, "source");
      const foreignRaw = `FOREIGN_RAW_SENTINEL ${"r".repeat(256 * 1024)}`;
      const foreignBody = `FOREIGN_BODY_SENTINEL ${"b".repeat(256 * 1024)}`;
      const foreign = live.addSource("file:///foreign.md", "md", "Foreign", foreignRaw);
      const foreignPage = live.addPage(
        "foreign-page", "Foreign metadata title", foreignBody, foreign.id, undefined, "concept",
      );

      const snapshot = live.createIngestStagingSnapshot(target.uri);
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain("FOREIGN_RAW_SENTINEL");
      expect(serialized).not.toContain("FOREIGN_BODY_SENTINEL");
      expect(serialized.length).toBeLessThan(10_000);

      staging.seedIngestStaging(snapshot, {
        uri: target.uri,
        type: "md",
        title: "Replacement",
        rawContent: "new target raw",
      });
      expect(staging.getSource(foreign.uri)).toMatchObject({
        id: foreign.id,
        raw_content: "",
      });
      expect(staging.getPage(foreignPage.slug)).toMatchObject({
        id: foreignPage.id,
        title: foreignPage.title,
        content: "",
        source_id: foreign.id,
        origin: "batch",
      });
      expect(staging.searchPages("FOREIGN_BODY_SENTINEL", 10)).toEqual([]);
    } finally {
      staging.close();
      live.close();
    }
  });

  test("does not update unchanged live pages during final reconcile", () => {
    const live = new Store(":memory:");
    const staging = new Store(":memory:");
    try {
      const source = live.addSource("file:///unchanged.md", "md", "Unchanged", "same raw");
      const page = live.addPage(
        "unchanged-page", "Unchanged page", "stable searchable body",
        source.id, "unchanged-page", "source", 3,
      );
      const liveDb = (live as any).db;
      liveDb.prepare("UPDATE pages SET updated_at = ? WHERE id = ?")
        .run("2001-02-03T04:05:06.000Z", page.id);
      liveDb.exec("CREATE TEMP TABLE page_update_audit (page_id INTEGER NOT NULL)");
      liveDb.exec(`CREATE TEMP TRIGGER audit_page_update AFTER UPDATE ON pages
        WHEN NEW.id = ${page.id}
        BEGIN INSERT INTO page_update_audit (page_id) VALUES (NEW.id); END`);

      const draft = {
        uri: source.uri,
        type: "md",
        title: "Unchanged",
        rawContent: "same raw",
      };
      const stagedSource = staging.seedIngestStaging(
        live.createIngestStagingSnapshot(source.uri),
        draft,
      );
      staging.addPage(
        page.slug, page.title, page.content, stagedSource.id,
        page.section_anchor ?? undefined, page.page_type, page.display_order,
      );

      live.publishIngestGeneration(staging, stagedSource.id, draft, "9".repeat(64));

      expect(liveDb.prepare("SELECT updated_at FROM pages WHERE id = ?").get(page.id))
        .toEqual({ updated_at: "2001-02-03T04:05:06.000Z" });
      expect(liveDb.prepare("SELECT COUNT(*) as count FROM page_update_audit").get())
        .toEqual({ count: 0 });
      expect(live.getPage(page.slug)?.id).toBe(page.id);
      expect(live.searchPages("searchable", 5).map(result => result.slug)).toContain(page.slug);
    } finally {
      staging.close();
      live.close();
    }
  });

  test("an LLM failure through ingestFile leaves the live source generation unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-ingest-failure-"));
    const filePath = join(root, "course.md");
    writeFileSync(
      filePath,
      `# Replacement\n\n${"This replacement document contains enough text for ingestion. ".repeat(3)}`,
    );
    const live = new Store(join(root, "kiwi.db"));
    const source = live.addSource(filePath, "md", "Published title", "published raw");
    live.setSourceHash(source.id, "published-hash");
    const page = live.addPage("published", "Published", "published body", source.id, undefined, "source");
    live.addQuiz(page.id, "Published question?", "Published answer", "short_answer");
    const quiz = live.getQuizzesByPage(page.id)[0];
    live.updateQuizSRS(quiz.id, 5);
    live.addQuizAttempt(quiz.id, true);
    const completion = spyOn(LLMClient.prototype, "chatComplete")
      .mockRejectedValue(new Error("simulated LLM outage"));
    try {
      await expect(withFence(live, 1, () => ingestFile(
        root, live, filePath, "course.md", TEST_LLM, null,
      ))).rejects.toThrow("Phase 1 chunk 1/1 failed");
      expect(live.getSource(filePath)).toMatchObject({
        id: source.id,
        title: "Published title",
        raw_content: "published raw",
        content_hash: "published-hash",
      });
      expect(live.getPage("published")).toMatchObject({ id: page.id, content: "published body" });
      expect(live.getQuizzesByPage(page.id)[0]).toMatchObject({ id: quiz.id, interval: 1 });
      expect(live.getQuizHistory(10)).toHaveLength(1);
      expect(existsSync(join(root, ".kiwimu-ingest-staging"))).toBe(true);
    } finally {
      completion.mockRestore();
      live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("post-commit telemetry failure does not turn a published ingest into an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-ingest-telemetry-"));
    const filePath = join(root, "course.md");
    writeFileSync(
      filePath,
      `# Published\n\n${"This document contains enough text for successful ingestion. ".repeat(3)}`,
    );
    const live = new Store(join(root, "kiwi.db"));
    const completion = spyOn(LLMClient.prototype, "chatComplete")
      .mockImplementation(async (system: string) => system.includes("document analyzer")
        ? JSON.stringify([{
            title: "Published section",
            content: "Published generation body with enough detail to pass structure validation.",
            level: 1,
          }])
        : JSON.stringify([]));
    const usage = spyOn(live, "addUsageLog").mockImplementation(() => {
      throw new Error("replacement fence rejected telemetry");
    });
    const activity = spyOn(live, "addActivityLog").mockImplementation(() => {
      throw new Error("replacement fence rejected telemetry");
    });
    try {
      const result = await live.runWithContentFence(
        live.activateContentFence({
          resource: "content-mutation",
          ownerToken: "telemetry-owner",
          fencingToken: 1,
        }),
        () => ingestFile(
          root,
          live,
          filePath,
          "course.md",
          { provider: "gemini", model: "test", api_key: "test", endpoint: "" },
          null,
          undefined,
          undefined,
          { extractFigures: false },
        ),
      );

      expect(result.sourceCount).toBe(1);
      expect(live.getSource(filePath)?.title).toBe("Published");
      expect(live.listPages().some((page) => page.content.includes("Published generation body"))).toBeTrue();
    } finally {
      activity.mockRestore();
      usage.mockRestore();
      completion.mockRestore();
      live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resumes a durable private staging database only for the same owner and generation", () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-ingest-stage-"));
    const live = new Store(":memory:");
    const hash = "a".repeat(64);
    const draft = { uri: "file:///resume.md", type: "md", title: "Resume", rawContent: "raw" };
    try {
      const first = withFence(live, 1, () => openIngestStaging(root, live, draft, hash, TEST_FINGERPRINT));
      first.store.commitIngestStep(() => {
        first.store.addPage("partial", "Partial", "staged only", first.source.id, "partial", "source");
        first.store.setCheckpoint(first.source.id, "phase1_chunk", 0, first.checkpointHash);
      });
      expect(statSync(dirname(first.dbPath)).mode & 0o777).toBe(0o700);
      expect(statSync(first.dbPath).mode & 0o777).toBe(0o600);
      first.store.close();

      const resumed = withFence(live, 1, () => openIngestStaging(root, live, draft, hash, TEST_FINGERPRINT));
      expect(resumed.store.getPage("partial")?.content).toBe("staged only");
      expect(resumed.store.checkpointsMatchInput(resumed.source.id, resumed.checkpointHash)).toBe(true);
      resumed.store.close();
      cleanupIngestStaging(resumed);
      expect(existsSync(resumed.dbPath)).toBe(false);
    } finally {
      live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("isolates replacement ownership and poisons stale stage mutations", () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-ingest-owner-"));
    const live = new Store(join(root, "kiwi.db"));
    const hash = "d".repeat(64);
    const draft = { uri: "file:///owned.md", type: "md", title: "Owned", rawContent: "raw" };
    try {
      const staleFence = live.activateContentFence({
        resource: "content-mutation", ownerToken: "stale-owner", fencingToken: 1,
      });
      const staleStage = live.runWithContentFence(staleFence, () =>
        openIngestStaging(root, live, draft, hash, TEST_FINGERPRINT));
      staleStage.store.addPage(
        "stale-partial", "Stale partial", "must never be adopted",
        staleStage.source.id, undefined, "source",
      );

      const replacementFence = live.activateContentFence({
        resource: "content-mutation", ownerToken: "replacement-owner", fencingToken: 2,
      });
      const replacementStage = live.runWithContentFence(replacementFence, () =>
        openIngestStaging(root, live, draft, hash, TEST_FINGERPRINT));

      expect(replacementStage.dbPath).not.toBe(staleStage.dbPath);
      expect(replacementStage.store.getPage("stale-partial")).toBeNull();
      expect(() => staleStage.store.addPage(
        "stale-poison", "Stale poison", "must fail",
        staleStage.source.id, undefined, "source",
      )).toThrow("stale or no longer owned");

      replacementStage.store.addPage(
        "replacement", "Replacement", "owned output",
        replacementStage.source.id, undefined, "source",
      );
      live.runWithContentFence(replacementFence, () => live.publishIngestGeneration(
        replacementStage.store, replacementStage.source.id, draft, hash,
      ));
      expect(live.getPage("replacement")?.content).toBe("owned output");
      expect(live.getPage("stale-partial")).toBeNull();
      expect(live.getPage("stale-poison")).toBeNull();

      staleStage.store.close();
      replacementStage.store.close();
    } finally {
      live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not resume checkpoints after persona schema or model changes", () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-ingest-fingerprint-"));
    const live = new Store(join(root, "kiwi.db"));
    const hash = "e".repeat(64);
    const draft = { uri: "file:///config.md", type: "md", title: "Config", rawContent: "raw" };
    const original = createIngestGenerationFingerprint(TEST_LLM, null, undefined, {
      sourceType: "md", title: draft.title, extractFigures: false,
    });
    const changed = createIngestGenerationFingerprint(
      { ...TEST_LLM, model: "different-model" },
      { name: "expert", description: "", system_prompt: "changed", content_style: "precise" },
      { categories: ["changed"], terms: { kiwi: "fruit" } },
      { sourceType: "md", title: draft.title, extractFigures: false },
    );
    try {
      const first = withFence(live, 1, () => openIngestStaging(root, live, draft, hash, original));
      first.store.commitIngestStep(() => {
        first.store.addPage("old-config", "Old config", "partial", first.source.id, undefined, "source");
        first.store.setCheckpoint(first.source.id, "phase1_chunk", 0, first.checkpointHash);
      });
      first.store.close();

      const changedStage = withFence(live, 1, () => openIngestStaging(root, live, draft, hash, changed));
      expect(changedStage.dbPath).not.toBe(first.dbPath);
      expect(changedStage.store.hasCheckpoints(changedStage.source.id)).toBeFalse();
      expect(changedStage.store.getPage("old-config")).toBeNull();
      changedStage.store.close();
    } finally {
      live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds abandoned staging generations without removing the active or recent generation", () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-ingest-stage-gc-"));
    const live = new Store(":memory:");
    const draft = { uri: "file:///bounded.md", type: "md", title: "Bounded", rawContent: "raw" };
    const paths: string[] = [];
    try {
      for (let index = 0; index < 5; index++) {
        const handle = withFence(live, 1, () => openIngestStaging(
          root, live, draft, index.toString(16).repeat(64), TEST_FINGERPRINT,
        ));
        paths.push(handle.dbPath);
        handle.store.close();
      }
      mkdirSync(`${paths[2]}.figures`);
      writeFileSync(`${paths[2]}-wal`, "abandoned sidecar");

      const modifiedAt = [1_000, 2_000, 3_000, 6_000, 9_900];
      for (const [index, dbPath] of paths.entries()) {
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(`${dbPath}${suffix}`)) {
            utimesSync(`${dbPath}${suffix}`, modifiedAt[index] / 1_000, modifiedAt[index] / 1_000);
          }
        }
      }
      utimesSync(`${paths[2]}.figures`, 3, 3);
      utimesSync(`${paths[2]}-wal`, 3, 3);

      const result = cleanupAbandonedIngestStaging(dirname(paths[0]), {
        protectedDbPath: paths[0],
        now: 10_000,
        minimumAgeMs: 500,
        ttlMs: 5_000,
        maxGenerationsPerSource: 2,
      });

      expect(result).toEqual({ removed: 2, failures: 0 });
      expect(existsSync(paths[0])).toBeTrue();
      expect(existsSync(paths[1])).toBeFalse();
      expect(existsSync(paths[2])).toBeFalse();
      expect(existsSync(`${paths[2]}-wal`)).toBeFalse();
      expect(existsSync(`${paths[2]}.figures`)).toBeFalse();
      expect(existsSync(paths[3])).toBeTrue();
      expect(existsSync(paths[4])).toBeTrue();
    } finally {
      live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rolls a staged page and its checkpoint back as one ingest step", () => {
    const stage = new Store(":memory:");
    try {
      const source = stage.addSource("file:///atomic.md", "md", "Atomic", "raw");
      expect(() => stage.commitIngestStep(() => {
        stage.addPage("never-visible", "Never", "partial", source.id, undefined, "source");
        stage.setCheckpoint(source.id, "phase1_chunk", 0, "b".repeat(64));
        throw new Error("checkpoint commit failed");
      })).toThrow("checkpoint commit failed");
      expect(stage.getPage("never-visible")).toBeNull();
      expect(stage.hasCheckpoints(source.id)).toBe(false);
    } finally {
      stage.close();
    }
  });

  test("resetting a staged generation preserves source-owned user pages", () => {
    const stage = new Store(":memory:");
    try {
      const source = stage.addSource("file:///reset.md", "md", "Reset", "raw");
      stage.addPage("partial-batch", "Partial", "partial", source.id, undefined, "source");
      const user = stage.addPage("manual-note", "Manual", "user content", source.id, undefined, "concept");
      stage.updatePageOrigin(user.slug, "user", "question", user.id);
      stage.setCheckpoint(source.id, "phase1_chunk", 0, "f".repeat(64));

      expect(prepareIngestAttempt(stage, source.id, "0".repeat(64))).toBe(false);
      expect(stage.getPage("partial-batch")).toBeNull();
      expect(stage.getPage("manual-note")).toMatchObject({ id: user.id, origin: "user", content: "user content" });
    } finally {
      stage.close();
    }
  });

  test("publishes one generation atomically while preserving stable learning and user state", () => {
    const live = new Store(":memory:");
    const staging = new Store(":memory:");
    try {
      const source = live.addSource("file:///course.md", "md", "Old title", "old raw");
      live.setSourceHash(source.id, "old-hash");
      const retainedSource = live.addPage(
        "chapter-one", "Chapter one", "old source", source.id, "chapter-one", "source", 0,
      );
      const removedSource = live.addPage(
        "removed-section", "Removed", "obsolete", source.id, "removed-section", "source", 1,
      );
      const retainedConcept = live.addPage(
        "stable-concept", "Stable concept", "old concept", source.id, "stable-concept", "concept", 0,
      );
      live.addPage(
        "historic-concept", "Historic concept", "obsolete-retired-concept-token", source.id, "historic-concept", "concept", 0,
      );
      const userPageId = live.addDynamicPage(
        "promoted-note", "Promoted note", "user content", removedSource.id, "why?",
      );
      live.addQuiz(retainedConcept.id, "Exact?", "Yes", "short_answer", "old explanation");
      const stableQuiz = live.getQuizzesByPage(retainedConcept.id)[0];
      live.updateQuizSRS(stableQuiz.id, 5);
      live.addQuizAttempt(stableQuiz.id, true);
      live.addQuiz(retainedConcept.id, "Stale?", "Old", "short_answer", "remove me");
      live.saveEmbedding(retainedConcept.id, new Float32Array([1, 2]), "test-model");
      live.replaceChunks(retainedConcept.id, ["old chunk"], "old-content");

      const draft = {
        uri: source.uri,
        type: "md",
        title: "New title",
        rawContent: "new raw",
      };
      const stagedSource = staging.seedIngestStaging(
        live.createIngestStagingSnapshot(source.uri),
        draft,
      );
      // Progressive staging writes do not affect the live generation.
      staging.addPage(
        "chapter-one", "Chapter one", "new source", stagedSource.id, "chapter-one", "source", 0,
      );
      const stagedConcept = staging.addPage(
        "stable-concept", "Stable concept", "new concept", stagedSource.id, "stable-concept", "concept", 0,
      );
      staging.addQuiz(stagedConcept.id, "Exact?", "Yes", "short_answer", "new explanation");
      staging.addCitation(stagedConcept.id, stagedSource.id, staging.getPage("chapter-one")!.id, undefined, "claim");
      staging.addLink(stagedConcept.id, staging.getPage("chapter-one")!.id, "Chapter one");
      expect(live.getPage("chapter-one")?.content).toBe("old source");
      expect(live.getSource(source.uri)?.title).toBe("Old title");

      const published = live.publishIngestGeneration(
        staging,
        stagedSource.id,
        draft,
        "c".repeat(64),
      );

      expect(published.id).toBe(source.id);
      expect(published).toMatchObject({ title: "New title", raw_content: "new raw", content_hash: "c".repeat(64) });
      expect(live.getPage("chapter-one")).toMatchObject({ id: retainedSource.id, content: "new source" });
      expect(live.getPage("stable-concept")).toMatchObject({ id: retainedConcept.id, content: "new concept" });
      expect(live.getPage("removed-section")).toBeNull();
      expect(live.getPage("historic-concept")).toBeNull();
      expect(live.searchPages("obsolete-retired-concept-token")).toEqual([]);
      expect(live.getPageById(userPageId)).toMatchObject({ origin: "user", content: "user content", parent_page_id: null });

      const quizzes = live.getQuizzesByPage(retainedConcept.id);
      expect(quizzes).toHaveLength(1);
      expect(quizzes[0]).toMatchObject({
        id: stableQuiz.id,
        question: "Exact?",
        answer: "Yes",
        interval: 1,
        explanation: "new explanation",
      });
      expect(live.getQuizHistory(10)).toHaveLength(1);
      expect(live.getEmbedding(retainedConcept.id)).toBeNull();
      expect(live.getChunkContentHash(retainedConcept.id)).toBeNull();
      expect(live.getCitationsForPage(retainedConcept.id)[0]).toMatchObject({
        source_id: source.id,
        source_page_id: retainedSource.id,
      });
      expect(live.getForwardLinks(retainedConcept.id)[0]?.id).toBe(retainedSource.id);
    } finally {
      staging.close();
      live.close();
    }
  });

  test("rolls source metadata and pages back when final reconcile conflicts", () => {
    const live = new Store(":memory:");
    const staging = new Store(":memory:");
    try {
      const source = live.addSource("file:///conflict.md", "md", "Old", "old raw");
      const draft = { uri: source.uri, type: "md", title: "New", rawContent: "new raw" };
      const stagedSource = staging.seedIngestStaging(
        live.createIngestStagingSnapshot(source.uri),
        draft,
      );
      staging.addPage("late-conflict", "Generated", "new page", stagedSource.id, undefined, "source");
      live.addPage("late-conflict", "Manual", "must survive", undefined, undefined, "concept");

      expect(() => live.publishIngestGeneration(
        staging,
        stagedSource.id,
        draft,
        "d".repeat(64),
      )).toThrow("no longer available");
      expect(live.getSource(source.uri)).toMatchObject({ title: "Old", raw_content: "old raw" });
      expect(live.getSourceHash(source.uri)).toBeNull();
      expect(live.getPage("late-conflict")).toMatchObject({ title: "Manual", content: "must survive" });
    } finally {
      staging.close();
      live.close();
    }
  });

  test("fails closed when a staged link or citation target slug is reused by another source", () => {
    for (const referenceKind of ["link", "citation"] as const) {
      const live = new Store(":memory:");
      const staging = new Store(":memory:");
      try {
        const target = live.addSource("file:///target.md", "md", "Target old", "old raw");
        live.setSourceHash(target.id, "old-hash");
        const sourceA = live.addSource("file:///source-a.md", "md", "Source A", "source a");
        const sourceB = live.addSource("file:///source-b.md", "md", "Source B", "source b");
        const originalReference = live.addPage(
          "shared-reference", "Source A reference", "source A facts", sourceA.id, undefined, "source",
        );
        const draft = { uri: target.uri, type: "md", title: "Target new", rawContent: "new raw" };
        const stagedTarget = staging.seedIngestStaging(
          live.createIngestStagingSnapshot(target.uri),
          draft,
        );
        const stagedConcept = staging.addPage(
          "generated-concept", "Generated concept", "generated", stagedTarget.id, undefined, "concept",
        );
        const stagedReference = staging.getPage("shared-reference")!;
        if (referenceKind === "link") {
          staging.addLink(stagedConcept.id, stagedReference.id, "Source A reference");
        } else {
          staging.addCitation(stagedConcept.id, sourceA.id, stagedReference.id, undefined, "source A claim");
        }

        live.deletePagesBySource(sourceA.id);
        const replacement = live.addPage(
          "shared-reference", "Source B replacement", "unrelated source B facts", sourceB.id, undefined, "source",
        );
        expect(replacement.id).not.toBe(originalReference.id);

        expect(() => live.publishIngestGeneration(
          staging,
          stagedTarget.id,
          draft,
          "9".repeat(64),
        )).toThrow("reference identity changed");
        expect(live.getSource(target.uri)).toMatchObject({
          title: "Target old",
          raw_content: "old raw",
          content_hash: "old-hash",
        });
        expect(live.getPage("generated-concept")).toBeNull();
        expect(live.getPage("shared-reference")).toMatchObject({
          id: replacement.id,
          source_id: sourceB.id,
        });
      } finally {
        staging.close();
        live.close();
      }
    }
  });

  test("fails closed when re-ingest would replace administrator-edited batch content", () => {
    const live = new Store(":memory:");
    const staging = new Store(":memory:");
    try {
      const source = live.addSource("file:///manual-conflict.md", "md", "Old", "old raw");
      live.setSourceHash(source.id, "old-hash");
      const page = live.addPage(
        "edited-section", "Edited section", "generated v1", source.id, "edited-section", "source",
      );
      live.updatePageContentAsManualEdit(page.id, "administrator version");

      const draft = { uri: source.uri, type: "md", title: "New", rawContent: "new raw" };
      const stagedSource = staging.seedIngestStaging(
        live.createIngestStagingSnapshot(source.uri),
        draft,
      );
      staging.addPage(
        page.slug, "Edited section", "generated v2", stagedSource.id, "edited-section", "source",
      );
      let publishedFiles = false;

      let conflict: unknown;
      try {
        live.publishIngestGeneration(
          staging,
          stagedSource.id,
          draft,
          "a".repeat(64),
          () => { publishedFiles = true; },
        );
      } catch (error) {
        conflict = error;
      }

      expect(conflict).toBeInstanceOf(IngestManualEditConflictError);
      expect((conflict as IngestManualEditConflictError).slugs).toEqual([page.slug]);
      expect(publishedFiles).toBeFalse();
      expect(live.getSource(source.uri)).toMatchObject({
        id: source.id,
        title: "Old",
        raw_content: "old raw",
        content_hash: "old-hash",
      });
      expect(live.getPage(page.slug)).toMatchObject({
        id: page.id,
        content: "administrator version",
        manual_revision: 1,
      });
    } finally {
      staging.close();
      live.close();
    }
  });

  test("fails closed when re-ingest would delete an administrator-edited source page", () => {
    const live = new Store(":memory:");
    const staging = new Store(":memory:");
    try {
      const source = live.addSource("file:///manual-delete.md", "md", "Old", "old raw");
      const page = live.addPage(
        "removed-manual-section", "Removed section", "generated", source.id, undefined, "source",
      );
      live.updatePageContentAsManualEdit(page.id, "keep this edit");
      const draft = { uri: source.uri, type: "md", title: "New", rawContent: "new raw" };
      const stagedSource = staging.seedIngestStaging(
        live.createIngestStagingSnapshot(source.uri),
        draft,
      );
      staging.addPage("replacement", "Replacement", "new", stagedSource.id, undefined, "source");

      expect(() => live.publishIngestGeneration(
        staging,
        stagedSource.id,
        draft,
        "b".repeat(64),
      )).toThrow(IngestManualEditConflictError);
      expect(live.getPage(page.slug)).toMatchObject({
        id: page.id,
        content: "keep this edit",
        manual_revision: 1,
      });
      expect(live.getPage("replacement")).toBeNull();
      expect(live.getSource(source.uri)).toMatchObject({ title: "Old", raw_content: "old raw" });
    } finally {
      staging.close();
      live.close();
    }
  });

  test("rolls the live DB back when staged figure publication fails", () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figure-publish-"));
    const live = new Store(":memory:");
    const staging = new Store(":memory:");
    try {
      const source = live.addSource("file:///figures.pdf", "pdf", "Old", "old raw");
      live.setSourceHash(source.id, "old-figure-hash");
      const page = live.addPage("figure-page", "Figure page", "old body", source.id, undefined, "source");
      const draft = { uri: source.uri, type: "pdf", title: "New", rawContent: "new raw" };
      const stagedSource = staging.seedIngestStaging(
        live.createIngestStagingSnapshot(source.uri),
        draft,
      );
      staging.addPage("figure-page", "Figure page", "new body", stagedSource.id, undefined, "source");

      const stagedFigures = join(root, "staged");
      const liveFigures = join(root, "live");
      const filename = `src${stagedSource.id}-aaaaaaaa-1-1.png`;
      mkdirSync(stagedFigures);
      writeFileSync(join(stagedFigures, filename), "png");
      mkdirSync(liveFigures);
      // A directory at the target filename makes publication fail safely.
      mkdirSync(join(liveFigures, filename));

      expect(() => live.publishIngestGeneration(
        staging,
        stagedSource.id,
        draft,
        "e".repeat(64),
        () => publishStagedFigures(stagedFigures, liveFigures),
      )).toThrow("Unsafe live figure file");
      expect(live.getSource(source.uri)).toMatchObject({
        title: "Old",
        raw_content: "old raw",
        content_hash: "old-figure-hash",
      });
      expect(live.getPage("figure-page")).toMatchObject({ id: page.id, content: "old body" });
    } finally {
      staging.close();
      live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preflights the complete figure set and never overwrites a live target", () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figure-preflight-"));
    const stagedFigures = join(root, "staged");
    const liveFigures = join(root, "live");
    mkdirSync(stagedFigures);
    mkdirSync(liveFigures);
    const first = "src1-aaaaaaaaaaaa-1-1.png";
    const conflict = "src1-bbbbbbbbbbbb-1-1.png";
    writeFileSync(join(stagedFigures, first), "new first", { mode: 0o600 });
    writeFileSync(join(stagedFigures, conflict), "new conflict", { mode: 0o600 });
    writeFileSync(join(liveFigures, conflict), "published bytes", { mode: 0o600 });

    try {
      expect(() => publishStagedFigures(stagedFigures, liveFigures)).toThrow(
        "Live generation figure already exists",
      );
      expect(existsSync(join(stagedFigures, first))).toBeTrue();
      expect(existsSync(join(stagedFigures, conflict))).toBeTrue();
      expect(existsSync(join(liveFigures, first))).toBeFalse();
      expect(Bun.file(join(liveFigures, conflict)).text()).resolves.toBe("published bytes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a late invalid staged entry cannot partially publish earlier files", () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figure-invalid-"));
    const stagedFigures = join(root, "staged");
    const liveFigures = join(root, "live");
    mkdirSync(stagedFigures);
    mkdirSync(liveFigures);
    const valid = "src1-aaaaaaaaaaaa-1-1.png";
    writeFileSync(join(stagedFigures, valid), "valid", { mode: 0o600 });
    writeFileSync(join(stagedFigures, "zz-operator.png"), "unexpected");

    try {
      expect(() => publishStagedFigures(stagedFigures, liveFigures)).toThrow(
        "Unsafe staged figure filename",
      );
      expect(existsSync(join(stagedFigures, valid))).toBeTrue();
      expect(existsSync(join(liveFigures, valid))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two delayed new sources never share figure names when staging predicts the same ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figure-namespace-"));
    const live = new Store(join(root, "kiwi.db"));
    const contentHash = "a".repeat(64);
    const draftA = { uri: "file:///source-a.pdf", type: "pdf", title: "A", rawContent: "A" };
    const draftB = { uri: "file:///source-b.pdf", type: "pdf", title: "B", rawContent: "B" };
    const stageA = withFence(live, 1, () => openIngestStaging(root, live, draftA, contentHash, TEST_FINGERPRINT));
    const stageB = withFence(live, 1, () => openIngestStaging(root, live, draftB, contentHash, TEST_FINGERPRINT));

    try {
      expect(stageA.source.id).toBe(stageB.source.id);
      const prefixA = ingestFigurePrefix(stageA, contentHash);
      const prefixB = ingestFigurePrefix(stageB, contentHash);
      expect(prefixA).not.toBe(prefixB);

      const filenameA = `${prefixA}-1-1.png`;
      const filenameB = `${prefixB}-1-1.png`;
      const figuresA = prepareIngestFigureStaging(stageA);
      const figuresB = prepareIngestFigureStaging(stageB);
      writeFileSync(join(figuresA, filenameA), "figure A", { mode: 0o600 });
      writeFileSync(join(figuresB, filenameB), "figure B", { mode: 0o600 });
      stageA.store.addFigure(stageA.source.id, `/static/figures/${filenameA}`);
      stageB.store.addFigure(stageB.source.id, `/static/figures/${filenameB}`);

      live.publishIngestGeneration(stageA.store, stageA.source.id, draftA, contentHash, () =>
        publishStagedFigures(figuresA, join(root, "figures")),
      );
      live.publishIngestGeneration(stageB.store, stageB.source.id, draftB, contentHash, () =>
        publishStagedFigures(figuresB, join(root, "figures")),
      );

      expect(live.listFigurePaths()).toEqual([
        `/static/figures/${filenameA}`,
        `/static/figures/${filenameB}`,
      ].sort());
      expect(await Bun.file(join(root, "figures", filenameA)).text()).toBe("figure A");
      expect(await Bun.file(join(root, "figures", filenameB)).text()).toBe("figure B");
    } finally {
      stageA.store.close();
      stageB.store.close();
      live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replacement owners get distinct figure namespaces for the same source and input", () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figure-owner-namespace-"));
    const live = new Store(join(root, "kiwi.db"));
    const hash = "b".repeat(64);
    const draft = { uri: "file:///same.pdf", type: "pdf", title: "Same", rawContent: "same" };
    let first: ReturnType<typeof openIngestStaging> | null = null;
    let replacement: ReturnType<typeof openIngestStaging> | null = null;

    try {
      first = withFence(live, 1, () => openIngestStaging(root, live, draft, hash, TEST_FINGERPRINT));
      replacement = withFence(live, 2, () => openIngestStaging(root, live, draft, hash, TEST_FINGERPRINT));
      expect(first.sourceKey).toBe(replacement.sourceKey);
      expect(first.dbPath).not.toBe(replacement.dbPath);
      expect(ingestFigurePrefix(first, hash)).not.toBe(ingestFigurePrefix(replacement, hash));
    } finally {
      first?.store.close();
      replacement?.store.close();
      live.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("candidate figure overlay copies the exact DB generation and fails closed when missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figure-overlay-"));
    const staging = join(root, "staging");
    const candidateStatic = join(root, "candidate", "static");
    const candidateFigures = join(candidateStatic, "figures");
    mkdirSync(staging);
    mkdirSync(candidateStatic, { recursive: true });
    const stagedName = "gen-aaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccccccc-1-1.png";
    const existingName = "gen-aaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbb-dddddddddddddddd-1-1.png";
    const missingName = "gen-aaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbb-eeeeeeeeeeeeeeee-1-1.png";
    writeFileSync(join(staging, stagedName), "staged", { mode: 0o600 });

    try {
      expect(copyStagedFiguresForCandidate(staging, candidateFigures, [
        `/static/figures/${stagedName}`,
      ])).toBe(1);
      expect(await Bun.file(join(candidateFigures, stagedName)).text()).toBe("staged");
      expect(existsSync(join(staging, stagedName))).toBeTrue();

      writeFileSync(join(candidateFigures, existingName), "existing");
      expect(copyStagedFiguresForCandidate(staging, candidateFigures, [
        `/static/figures/${existingName}`,
      ])).toBe(0);
      expect(await Bun.file(join(candidateFigures, existingName)).text()).toBe("existing");

      expect(() => copyStagedFiguresForCandidate(staging, candidateFigures, [
        `/static/figures/${missingName}`,
      ])).toThrow("Candidate generation figure is missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
