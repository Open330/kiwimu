import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { normalizeTitle } from "./utils";
import { hardenSqliteSidecars, preparePrivateSqliteFile } from "./sqlite-permissions";
import {
  ActivityRepository,
  CitationRepository,
  ContentFenceRepository,
  QuizRepository,
} from "./repositories";
import type { CitationInput } from "./repositories/citation-repository";
import type {
  ActivityLogEntry,
  ActivityStats,
  Citation,
  LearningStats,
  Quiz,
  QuizHistoryEntry,
  QuizStats,
  SourceCoverage,
  UsageSummary,
  WeakConcept,
} from "./repositories";
import type { ContentFence, FenceIdentity } from "./repositories";

export type {
  ActivityLogEntry,
  ActivityStats,
  Citation,
  LearningStats,
  Quiz,
  QuizHistoryEntry,
  QuizStats,
  SourceCoverage,
  UsageSummary,
  WeakConcept,
} from "./repositories";
export type { ContentFence, FenceIdentity } from "./repositories";
export type { CitationInput } from "./repositories/citation-repository";

export interface Source {
  id: number;
  uri: string;
  type: string;
  title: string;
  raw_content: string;
  fetched_at: string;
  content_hash?: string | null;
}

export interface Page {
  id: number;
  slug: string;
  title: string;
  content: string;
  source_id: number | null;
  section_anchor: string | null;
  page_type: 'source' | 'concept';
  display_order: number;
  origin: string; // 'batch' | 'user'
  /** Monotonic marker for administrator edits to generated batch content. */
  manual_revision: number;
  user_question: string | null;
  parent_page_id: number | null;
  category: string | null;
}

export interface SourceMeta {
  id: number;
  uri: string;
  type: string;
  title: string;
  fetched_at: string;
}

export interface PageChunk {
  id: number;
  page_id: number;
  chunk_index: number;
  content: string;
  content_hash: string;
}

export interface ChunkEmbeddingRow {
  chunkId: number;
  pageId: number;
  chunkIndex: number;
  slug: string;
  title: string;
  content: string;
  pageType: string;
  embedding: Float32Array;
}

export interface Link {
  from_page_id: number;
  to_page_id: number;
  anchor_text: string;
}

export interface Figure {
  id: number;
  source_id: number;
  page_id: number | null;
  image_path: string;   // public/served path, e.g. "/static/figures/src12-fig1.png"
  caption: string | null;
  page_number: number | null;
  created_at: string;
}

export interface IngestSourceDraft {
  uri: string;
  type: string;
  title: string;
  rawContent: string;
}

interface IngestStagingSourceMetadata {
  id: number;
  uri: string;
  type: string;
  title: string;
  fetched_at: string;
  content_hash: string | null;
}

interface IngestStagingPageMetadata {
  id: number;
  slug: string;
  title: string;
  source_id: number | null;
  page_type: Page["page_type"];
  origin: string;
}

export interface IngestStagingSnapshot {
  targetSourceId: number;
  sources: IngestStagingSourceMetadata[];
  pages: IngestStagingPageMetadata[];
}

/**
 * Re-ingest must not silently replace or delete administrator-edited batch
 * content. Callers can surface this as an explicit, retry-insensitive conflict.
 */
export class IngestManualEditConflictError extends Error {
  readonly slugs: readonly string[];

  constructor(slugs: readonly string[]) {
    const uniqueSlugs = [...new Set(slugs)].sort();
    super(
      `재수집을 중단했습니다. 관리자 편집을 덮어쓰거나 삭제할 수 있습니다: ${uniqueSlugs.join(", ")}`,
    );
    this.name = "IngestManualEditConflictError";
    this.slugs = uniqueSlugs;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uri TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  raw_content TEXT,
  fetched_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  section_anchor TEXT,
  page_type TEXT NOT NULL DEFAULT 'concept',
  display_order INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'batch',
  manual_revision INTEGER NOT NULL DEFAULT 0 CHECK(manual_revision >= 0),
  user_question TEXT DEFAULT NULL,
  parent_page_id INTEGER DEFAULT NULL,
  category TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS links (
  from_page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  anchor_text TEXT,
  PRIMARY KEY (from_page_id, to_page_id, anchor_text)
);
CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  explanation TEXT DEFAULT '',
  quiz_type TEXT NOT NULL DEFAULT 'fill_blank',
  ease_factor REAL NOT NULL DEFAULT 2.5,
  interval INTEGER NOT NULL DEFAULT 0,
  next_review_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
CREATE INDEX IF NOT EXISTS idx_attempts_quiz_id ON quiz_attempts(quiz_id);
CREATE INDEX IF NOT EXISTS idx_pages_page_type ON pages(page_type);
CREATE INDEX IF NOT EXISTS idx_links_to_page ON links(to_page_id);
CREATE INDEX IF NOT EXISTS idx_links_from_page ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_page_id ON quizzes(page_id);
CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  batch_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  input_hash TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, phase, batch_index)
);
CREATE TABLE IF NOT EXISTS content_fences (
  resource TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL CHECK(epoch >= 1),
  owner_token TEXT NOT NULL,
  external_fencing_token INTEGER NOT NULL CHECK(external_fencing_token >= 1),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS page_embeddings (
  page_id INTEGER PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS page_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB,
  model TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(page_id, chunk_index),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_chunks_page ON page_chunks(page_id);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  title TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
CREATE TABLE IF NOT EXISTS citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  source_page_id INTEGER,
  excerpt TEXT,
  context TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
  FOREIGN KEY (source_page_id) REFERENCES pages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_citations_page ON citations(page_id);
CREATE INDEX IF NOT EXISTS idx_citations_source ON citations(source_id);
CREATE TABLE IF NOT EXISTS figures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  image_path TEXT NOT NULL,
  caption TEXT,
  page_number INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_figures_source ON figures(source_id);
CREATE INDEX IF NOT EXISTS idx_figures_page ON figures(page_id);
`;

const ADDITIVE_COLUMN_MIGRATIONS = [
  { table: "quizzes", column: "explanation", definition: "TEXT DEFAULT ''" },
  { table: "pages", column: "origin", definition: "TEXT NOT NULL DEFAULT 'batch'" },
  { table: "pages", column: "manual_revision", definition: "INTEGER NOT NULL DEFAULT 0 CHECK(manual_revision >= 0)" },
  { table: "pages", column: "user_question", definition: "TEXT DEFAULT NULL" },
  { table: "pages", column: "parent_page_id", definition: "INTEGER DEFAULT NULL" },
  { table: "pages", column: "category", definition: "TEXT DEFAULT NULL" },
  { table: "sources", column: "content_hash", definition: "TEXT DEFAULT NULL" },
  { table: "pipeline_checkpoints", column: "input_hash", definition: "TEXT DEFAULT NULL" },
  { table: "quizzes", column: "ease_factor", definition: "REAL NOT NULL DEFAULT 2.5" },
  { table: "quizzes", column: "interval", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "quizzes", column: "next_review_at", definition: "TEXT DEFAULT NULL" },
] as const;

const POST_MIGRATION_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_pages_origin ON pages(origin);
CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_page_id);
CREATE INDEX IF NOT EXISTS idx_pages_category ON pages(category);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, content, content=pages, content_rowid=id);

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
`;

export class Store {
  private db: Database;
  private contentIndexRevision = 0;
  readonly activityRepository: ActivityRepository;
  readonly quizRepository: QuizRepository;
  readonly citationRepository: CitationRepository;
  readonly contentFenceRepository: ContentFenceRepository;

  constructor(dbPath: string, options: { beforeMutation?: () => void } = {}) {
    preparePrivateSqliteFile(dbPath);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 30000");
    this.db.exec("PRAGMA journal_mode=WAL");
    hardenSqliteSidecars(dbPath);
    this.db.exec("PRAGMA foreign_keys=ON");
    try {
      this.initSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.contentFenceRepository = new ContentFenceRepository(this.db, options.beforeMutation);
    this.activityRepository = new ActivityRepository(this.db, this.contentFenceRepository);
    this.quizRepository = new QuizRepository(
      this.db,
      this.activityRepository,
      this.contentFenceRepository,
    );
    this.citationRepository = new CitationRepository(this.db, this.contentFenceRepository);
  }

  initSchema(): void {
    this.db.exec(SCHEMA);
    // Additive legacy migrations are scoped to one transaction. PRAGMA
    // inspection distinguishes an already-applied migration from a real ALTER
    // failure, which must abort startup instead of being silently ignored.
    const migrate = this.db.transaction(() => {
      for (const migration of ADDITIVE_COLUMN_MIGRATIONS) {
        const columns = this.db.prepare(`PRAGMA table_info("${migration.table}")`)
          .all() as Array<{ name: string }>;
        if (columns.some((column) => column.name === migration.column)) continue;
        this.db.exec(
          `ALTER TABLE "${migration.table}" ADD COLUMN "${migration.column}" ${migration.definition}`,
        );
      }
      this.db.exec(POST_MIGRATION_SCHEMA);
    });
    migrate();
    // FTS5 full-text search (may not be available in older SQLite builds)
    try { this.db.exec(FTS_SCHEMA); } catch {}
    this.rebuildFtsIndexIfNeeded();
  }

  private rebuildFtsIndexIfNeeded(): void {
    try {
      const pageCount = (this.db.prepare(
        "SELECT COUNT(*) as count FROM pages",
      ).get() as { count: number }).count;
      // pages_fts is an external-content FTS table, so COUNT(*) on the virtual
      // table reads `pages` even when its search index is empty. The docsize
      // shadow table reflects the rows that are actually indexed.
      const indexedCount = (this.db.prepare(
        "SELECT COUNT(*) as count FROM pages_fts_docsize",
      ).get() as { count: number }).count;
      if (pageCount !== indexedCount) this.rebuildFtsIndex();
    } catch {
      // FTS table might not exist in SQLite builds without FTS5 support.
    }
  }

  rebuildFtsIndex(): void {
    try {
      this.db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
    } catch {
      // FTS table might not exist yet in old databases
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Write a point-in-time SQLite snapshot for read/render candidate work.
   * The exclusive private file prevents an existing path (including a
   * symlink) from being followed or replaced.
   */
  writeSnapshot(filePath: string): void {
    writeFileSync(filePath, this.db.serialize(), {
      flag: "wx",
      mode: 0o600,
    });
  }

  /**
   * In-process revision for data used by the content index. The server uses it
   * to avoid serving a cached index after page/source/link mutations.
   */
  getContentIndexRevision(): number {
    return this.contentIndexRevision;
  }

  /** Activate the coordinator lease generation in the content database. */
  activateContentFence(identity: FenceIdentity): ContentFence {
    return this.contentFenceRepository.activate(identity);
  }

  getActiveContentFence(resource: string): ContentFence | null {
    return this.contentFenceRepository.getActive(resource);
  }

  /** Require the active fenced-job identity propagated through this async call. */
  requireCurrentContentFence(): ContentFence {
    const fence = this.contentFenceRepository.getCurrent();
    if (!fence) throw new Error("Ingest staging requires an active content fence");
    this.contentFenceRepository.assertActive(fence);
    return fence;
  }

  /** Validate a captured fence before a related external/staging mutation. */
  assertContentFence(fence: ContentFence): void {
    this.contentFenceRepository.assertActive(fence);
  }

  /**
   * Propagate a fence through an async job. Each Store/repository write inside
   * the callback validates it in the same transaction as that individual write.
   */
  runWithContentFence<T>(fence: ContentFence, operation: () => T): T {
    return this.contentFenceRepository.runWithFence(fence, operation);
  }

  /**
   * Publish already-staged content while the active job fence is held in the
   * same immediate SQLite transaction as its final filesystem mutation.
   *
   * The callback must be synchronous: keeping this transaction short lets a
   * replacement owner activate its fence promptly while preventing a stale
   * owner from beginning publication after that replacement.
   */
  publishContent<T>(publication: () => T): T {
    return this.contentFenceRepository.run(publication);
  }

  private mutate<T>(mutation: () => T): T {
    return this.contentFenceRepository.run(mutation);
  }

  /**
   * Commit one durable ingest unit together with its checkpoint. Callers keep
   * remote LLM work outside this boundary and place every resulting row plus
   * the checkpoint in the synchronous callback.
   */
  commitIngestStep<T>(operation: () => T): T {
    const commit = this.db.transaction(operation);
    return this.mutate(() => commit.immediate());
  }

  /**
   * Capture the live rows needed to generate in an isolated staging database.
   * Target-owned batch output is deliberately omitted: the new generation is
   * built from scratch. Other pages are represented only by slug/title and
   * ownership metadata, which is sufficient for collision detection and link
   * resolution without copying the rest of the corpus into JS and FTS.
   */
  createIngestStagingSnapshot(targetUri: string): IngestStagingSnapshot {
    const target = this.getSource(targetUri);
    const maxSourceId = (this.db.prepare(
      "SELECT COALESCE(MAX(id), 0) as id FROM sources",
    ).get() as { id: number }).id;
    const targetSourceId = target?.id ?? maxSourceId + 1;
    const pageMetadataSql = `
      SELECT id, slug, title, source_id, page_type, origin
      FROM pages`;
    const pages = target
      ? this.db.prepare(
          `${pageMetadataSql}
           WHERE source_id IS NULL OR source_id <> ? OR origin <> 'batch'
           ORDER BY id`,
        ).all(target.id) as IngestStagingPageMetadata[]
      : this.db.prepare(`${pageMetadataSql} ORDER BY id`).all() as IngestStagingPageMetadata[];
    return {
      targetSourceId,
      sources: this.db.prepare(
        `SELECT id, uri, type, title, fetched_at, content_hash
         FROM sources ORDER BY id`,
      ).all() as IngestStagingSourceMetadata[],
      pages,
    };
  }

  /** Seed a newly-created staging Store with a consistent live snapshot. */
  seedIngestStaging(snapshot: IngestStagingSnapshot, draft: IngestSourceDraft): Source {
    const seed = this.db.transaction(() => {
      const counts = this.db.prepare(
        "SELECT (SELECT COUNT(*) FROM sources) as sources, (SELECT COUNT(*) FROM pages) as pages",
      ).get() as { sources: number; pages: number };
      if (counts.sources !== 0 || counts.pages !== 0) {
        throw new Error("Ingest staging database is not empty");
      }

      const insertSource = this.db.prepare(
        `INSERT INTO sources (id, uri, type, title, raw_content, fetched_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      let targetPresent = false;
      for (const source of snapshot.sources) {
        const isTarget = source.id === snapshot.targetSourceId;
        targetPresent ||= isTarget;
        insertSource.run(
          source.id,
          isTarget ? draft.uri : source.uri,
          isTarget ? draft.type : source.type,
          isTarget ? draft.title : source.title,
          isTarget ? draft.rawContent : "",
          source.fetched_at,
          source.content_hash,
        );
      }
      if (!targetPresent) {
        insertSource.run(
          snapshot.targetSourceId,
          draft.uri,
          draft.type,
          draft.title,
          draft.rawContent,
          new Date().toISOString(),
          null,
        );
      }

      const insertPage = this.db.prepare(
        `INSERT INTO pages
           (id, slug, title, content, source_id, page_type, origin)
         VALUES (?, ?, ?, '', ?, ?, ?)`,
      );
      for (const page of snapshot.pages) {
        insertPage.run(
          page.id,
          page.slug,
          page.title,
          page.source_id,
          page.page_type,
          page.origin,
        );
      }

      return this.db.prepare("SELECT * FROM sources WHERE id = ?")
        .get(snapshot.targetSourceId) as Source;
    });
    return this.mutate(() => seed.immediate());
  }

  /**
   * Atomically reconcile a complete staged generation into the live Store.
   * Stable target-owned slugs retain their page IDs; matching quiz questions
   * retain quiz IDs, attempts, and SRS scheduling. Missing old generated pages
   * are removed so stale source sections and concepts are never exposed beside
   * the current generation; user/promoted pages are preserved.
   */
  publishIngestGeneration(
    staging: Store,
    stagingSourceId: number,
    draft: IngestSourceDraft,
    contentHash: string,
    publishFiles?: () => void,
  ): Source {
    const stagedPages = staging.db.prepare(
      "SELECT * FROM pages WHERE source_id = ? AND origin = 'batch' ORDER BY id",
    ).all(stagingSourceId) as Page[];
    const stagedLinks = staging.db.prepare(
      `SELECT fp.slug as from_slug,
              tp.id as to_staging_page_id,
              tp.slug as to_slug,
              tp.source_id as to_staging_source_id,
              ts.uri as to_source_uri,
              tp.origin as to_origin,
              l.anchor_text
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       JOIN pages tp ON tp.id = l.to_page_id
       LEFT JOIN sources ts ON ts.id = tp.source_id
       WHERE fp.source_id = ? AND fp.origin = 'batch'`,
    ).all(stagingSourceId) as Array<{
      from_slug: string;
      to_staging_page_id: number;
      to_slug: string;
      to_staging_source_id: number | null;
      to_source_uri: string | null;
      to_origin: string;
      anchor_text: string;
    }>;
    const stagedQuizzes = staging.db.prepare(
      `SELECT p.slug as page_slug, q.question, q.answer, q.explanation, q.quiz_type
       FROM quizzes q JOIN pages p ON p.id = q.page_id
       WHERE p.source_id = ? AND p.origin = 'batch'
       ORDER BY q.id`,
    ).all(stagingSourceId) as Array<{
      page_slug: string;
      question: string;
      answer: string;
      explanation: string;
      quiz_type: string;
    }>;
    const stagedCitations = staging.db.prepare(
      `SELECT p.slug as page_slug,
              c.source_id as staging_citation_source_id,
              s.uri as source_uri,
              sp.id as source_staging_page_id,
              sp.slug as source_page_slug,
              sp.source_id as source_page_staging_source_id,
              sps.uri as source_page_source_uri,
              sp.origin as source_page_origin,
              c.excerpt, c.context
       FROM citations c
       JOIN pages p ON p.id = c.page_id
       JOIN sources s ON s.id = c.source_id
       LEFT JOIN pages sp ON sp.id = c.source_page_id
       LEFT JOIN sources sps ON sps.id = sp.source_id
       WHERE p.source_id = ? AND p.origin = 'batch'
       ORDER BY c.id`,
    ).all(stagingSourceId) as Array<{
      page_slug: string;
      staging_citation_source_id: number;
      source_uri: string;
      source_staging_page_id: number | null;
      source_page_slug: string | null;
      source_page_staging_source_id: number | null;
      source_page_source_uri: string | null;
      source_page_origin: string | null;
      excerpt: string | null;
      context: string | null;
    }>;
    const stagedFigures = staging.db.prepare(
      `SELECT p.slug as page_slug, f.image_path, f.caption, f.page_number
       FROM figures f LEFT JOIN pages p ON p.id = f.page_id
       WHERE f.source_id = ? ORDER BY f.id`,
    ).all(stagingSourceId) as Array<{
      page_slug: string | null;
      image_path: string;
      caption: string | null;
      page_number: number | null;
    }>;

    const publish = this.db.transaction((): Source => {
      this.db.prepare(
        `INSERT INTO sources (uri, type, title, raw_content, fetched_at, content_hash)
         VALUES (?, ?, ?, ?, datetime('now'), ?)
         ON CONFLICT(uri) DO UPDATE SET
           type = excluded.type,
           title = excluded.title,
           raw_content = excluded.raw_content,
           fetched_at = excluded.fetched_at,
           content_hash = excluded.content_hash`,
      ).run(draft.uri, draft.type, draft.title, draft.rawContent, contentHash);
      const liveSource = this.db.prepare("SELECT * FROM sources WHERE uri = ?")
        .get(draft.uri) as Source;

      const stagedSlugs = new Set(stagedPages.map((page) => page.slug));
      for (const page of stagedPages) {
        const existing = this.db.prepare(
          "SELECT id, source_id, origin, content, manual_revision FROM pages WHERE slug = ?",
        ).get(page.slug) as {
          id: number;
          source_id: number | null;
          origin: string;
          content: string;
          manual_revision: number;
        } | undefined;
        if (existing && (existing.source_id !== liveSource.id || existing.origin !== "batch")) {
          throw new Error(`Staged page slug is no longer available: ${page.slug}`);
        }
        if (existing?.manual_revision && existing.content !== page.content) {
          throw new IngestManualEditConflictError([page.slug]);
        }
      }

      const obsoleteGeneratedPages = this.db.prepare(
        `SELECT id, slug, manual_revision FROM pages
         WHERE source_id = ? AND origin = 'batch'`,
      ).all(liveSource.id) as Array<{ id: number; slug: string; manual_revision: number }>;
      for (const page of obsoleteGeneratedPages) {
        if (stagedSlugs.has(page.slug)) continue;
        if (page.manual_revision > 0) {
          throw new IngestManualEditConflictError([page.slug]);
        }
        // Promoted/user pages survive even when their old source section does not.
        this.db.prepare(
          "UPDATE pages SET parent_page_id = NULL WHERE origin = 'user' AND parent_page_id = ?",
        ).run(page.id);
        this.db.prepare("DELETE FROM pages WHERE id = ?").run(page.id);
      }

      const updatePage = this.db.prepare(
        `UPDATE pages SET title = ?, content = ?, source_id = ?, section_anchor = ?,
          page_type = ?, display_order = ?, category = ?, updated_at = datetime('now')
         WHERE slug = ?`,
      );
      const insertPage = this.db.prepare(
        `INSERT INTO pages
           (slug, title, content, source_id, section_anchor, page_type,
            display_order, origin, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'batch', ?)`,
      );
      for (const page of stagedPages) {
        const existing = this.db.prepare(
          `SELECT id, title, content, source_id, section_anchor, page_type,
                  display_order, category
           FROM pages WHERE slug = ?`,
        ).get(page.slug) as {
          id: number;
          title: string;
          content: string;
          source_id: number | null;
          section_anchor: string | null;
          page_type: Page["page_type"];
          display_order: number;
          category: string | null;
        } | undefined;
        if (existing) {
          const contentChanged = existing.content !== page.content;
          const metadataChanged =
            existing.title !== page.title ||
            existing.source_id !== liveSource.id ||
            existing.section_anchor !== page.section_anchor ||
            existing.page_type !== page.page_type ||
            existing.display_order !== page.display_order ||
            existing.category !== page.category;
          if (contentChanged || metadataChanged) {
            updatePage.run(
              page.title,
              page.content,
              liveSource.id,
              page.section_anchor,
              page.page_type,
              page.display_order,
              page.category,
              page.slug,
            );
          }
          if (contentChanged) {
            this.db.prepare("DELETE FROM page_embeddings WHERE page_id = ?").run(existing.id);
            this.db.prepare("DELETE FROM page_chunks WHERE page_id = ?").run(existing.id);
          }
        } else {
          insertPage.run(
            page.slug,
            page.title,
            page.content,
            liveSource.id,
            page.section_anchor,
            page.page_type,
            page.display_order,
            page.category,
          );
        }
      }

      const livePageIds = new Map<string, number>();
      for (const page of stagedPages) {
        const row = this.db.prepare("SELECT id FROM pages WHERE slug = ?")
          .get(page.slug) as { id: number };
        livePageIds.set(page.slug, row.id);
        this.db.prepare("DELETE FROM links WHERE from_page_id = ?").run(row.id);
      }

      const resolveStagedReference = (reference: {
        stagingPageId: number;
        slug: string;
        stagingSourceId: number | null;
        sourceUri: string | null;
        origin: string;
      }): { id: number; source_id: number | null } => {
        if (
          reference.stagingSourceId === stagingSourceId &&
          reference.origin === "batch"
        ) {
          const id = livePageIds.get(reference.slug);
          if (id === undefined) {
            throw new Error(`Staged page reference is no longer available: ${reference.slug}`);
          }
          return { id, source_id: liveSource.id };
        }

        const liveReference = this.db.prepare(
          `SELECT p.id, p.slug, p.source_id, p.origin, s.uri as source_uri
           FROM pages p LEFT JOIN sources s ON s.id = p.source_id
           WHERE p.id = ?`,
        ).get(reference.stagingPageId) as {
          id: number;
          slug: string;
          source_id: number | null;
          origin: string;
          source_uri: string | null;
        } | undefined;
        const expectedLiveSourceId = reference.stagingSourceId === stagingSourceId
          ? liveSource.id
          : reference.stagingSourceId;
        if (
          !liveReference ||
          liveReference.slug !== reference.slug ||
          liveReference.source_id !== expectedLiveSourceId ||
          liveReference.source_uri !== reference.sourceUri ||
          liveReference.origin !== reference.origin
        ) {
          throw new Error(`Staged page reference identity changed: ${reference.slug}`);
        }
        return { id: liveReference.id, source_id: liveReference.source_id };
      };

      for (const link of stagedLinks) {
        const fromId = livePageIds.get(link.from_slug);
        if (fromId === undefined) {
          throw new Error(`Staged link source is no longer available: ${link.from_slug}`);
        }
        const to = resolveStagedReference({
          stagingPageId: link.to_staging_page_id,
          slug: link.to_slug,
          stagingSourceId: link.to_staging_source_id,
          sourceUri: link.to_source_uri,
          origin: link.to_origin,
        });
        this.db.prepare(
          "INSERT OR IGNORE INTO links (from_page_id, to_page_id, anchor_text) VALUES (?, ?, ?)",
        ).run(fromId, to.id, link.anchor_text);
      }

      const stagedQuizzesByPage = new Map<string, typeof stagedQuizzes>();
      for (const quiz of stagedQuizzes) {
        const pageQuizzes = stagedQuizzesByPage.get(quiz.page_slug) ?? [];
        pageQuizzes.push(quiz);
        stagedQuizzesByPage.set(quiz.page_slug, pageQuizzes);
      }
      for (const [pageSlug, pageId] of livePageIds) {
        const exactKeys = new Set(
          (stagedQuizzesByPage.get(pageSlug) ?? []).map(
            (quiz) => JSON.stringify([quiz.question, quiz.answer, quiz.quiz_type]),
          ),
        );
        const existingQuizzes = this.db.prepare(
          "SELECT id, question, answer, quiz_type FROM quizzes WHERE page_id = ?",
        ).all(pageId) as Array<{
          id: number;
          question: string;
          answer: string;
          quiz_type: string;
        }>;
        for (const quiz of existingQuizzes) {
          const key = JSON.stringify([quiz.question, quiz.answer, quiz.quiz_type]);
          if (!exactKeys.has(key)) {
            this.db.prepare("DELETE FROM quizzes WHERE id = ?").run(quiz.id);
          }
        }
      }
      for (const quiz of stagedQuizzes) {
        const pageId = livePageIds.get(quiz.page_slug);
        if (pageId === undefined) continue;
        const existing = this.db.prepare(
          `SELECT id FROM quizzes
           WHERE page_id = ? AND question = ? AND answer = ? AND quiz_type = ?
           ORDER BY id LIMIT 1`,
        ).get(pageId, quiz.question, quiz.answer, quiz.quiz_type) as { id: number } | undefined;
        if (existing) {
          this.db.prepare(
            "UPDATE quizzes SET explanation = ? WHERE id = ?",
          ).run(quiz.explanation, existing.id);
        } else {
          this.db.prepare(
            `INSERT INTO quizzes (page_id, question, answer, explanation, quiz_type)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(pageId, quiz.question, quiz.answer, quiz.explanation, quiz.quiz_type);
        }
      }

      for (const pageId of livePageIds.values()) {
        this.db.prepare("DELETE FROM citations WHERE page_id = ?").run(pageId);
      }
      for (const citation of stagedCitations) {
        const pageId = livePageIds.get(citation.page_slug);
        if (pageId === undefined) {
          throw new Error(`Staged citation page is no longer available: ${citation.page_slug}`);
        }
        const source = citation.staging_citation_source_id === stagingSourceId
          ? liveSource
          : this.db.prepare("SELECT * FROM sources WHERE id = ? AND uri = ?")
              .get(citation.staging_citation_source_id, citation.source_uri) as Source | undefined;
        if (!source || source.uri !== citation.source_uri) {
          throw new Error(`Staged citation source identity changed: ${citation.source_uri}`);
        }
        const sourcePage = citation.source_staging_page_id !== null &&
          citation.source_page_slug !== null &&
          citation.source_page_origin !== null
          ? resolveStagedReference({
              stagingPageId: citation.source_staging_page_id,
              slug: citation.source_page_slug,
              stagingSourceId: citation.source_page_staging_source_id,
              sourceUri: citation.source_page_source_uri,
              origin: citation.source_page_origin,
            })
          : undefined;
        if (sourcePage && sourcePage.source_id !== source.id) {
          throw new Error(`Staged citation source ownership changed: ${citation.source_page_slug}`);
        }
        this.db.prepare(
          `INSERT INTO citations (page_id, source_id, source_page_id, excerpt, context)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(pageId, source.id, sourcePage?.id ?? null, citation.excerpt, citation.context);
      }

      this.db.prepare("DELETE FROM figures WHERE source_id = ?").run(liveSource.id);
      for (const figure of stagedFigures) {
        this.db.prepare(
          `INSERT INTO figures (source_id, page_id, image_path, caption, page_number)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          liveSource.id,
          figure.page_slug ? livePageIds.get(figure.page_slug) ?? null : null,
          figure.image_path,
          figure.caption,
          figure.page_number,
        );
      }

      this.db.prepare("DELETE FROM pipeline_checkpoints WHERE source_id = ?")
        .run(liveSource.id);
      publishFiles?.();
      return this.db.prepare("SELECT * FROM sources WHERE id = ?")
        .get(liveSource.id) as Source;
    });

    const source = this.mutate(() => publish.immediate());
    this.contentIndexRevision++;
    return source;
  }

  // --- Sources ---

  addSource(uri: string, type: string, title: string, rawContent: string): Source {
    const source = this.mutate(() => {
      const existing = this.db.prepare("SELECT * FROM sources WHERE uri = ?").get(uri) as Source | undefined;
      if (existing) {
        // Update existing source, keep same ID to preserve FK relationships
        this.db
          .prepare("UPDATE sources SET type = ?, title = ?, raw_content = ?, fetched_at = datetime('now') WHERE id = ?")
          .run(type, title, rawContent, existing.id);
        return this.db.prepare("SELECT * FROM sources WHERE id = ?").get(existing.id) as Source;
      }
      this.db
        .prepare("INSERT INTO sources (uri, type, title, raw_content) VALUES (?, ?, ?, ?)")
        .run(uri, type, title, rawContent);
      return this.db.prepare("SELECT * FROM sources WHERE uri = ?").get(uri) as Source;
    });
    this.contentIndexRevision++;
    return source;
  }

  getSource(uri: string): Source | null {
    return (this.db.prepare("SELECT * FROM sources WHERE uri = ?").get(uri) as Source) ?? null;
  }

  countSources(): number {
    return (this.db.prepare("SELECT COUNT(*) as count FROM sources").get() as any).count;
  }

  listSources(): Source[] {
    return this.db.prepare("SELECT * FROM sources ORDER BY fetched_at DESC").all() as Source[];
  }

  listSourcesMeta(): SourceMeta[] {
    return this.db.prepare("SELECT id, uri, type, title, fetched_at FROM sources ORDER BY id DESC").all() as SourceMeta[];
  }

  /** Content hash of the last successful ingest for a URI, or null if never/legacy. */
  getSourceHash(uri: string): string | null {
    const row = this.db.prepare("SELECT content_hash FROM sources WHERE uri = ?").get(uri) as { content_hash: string | null } | undefined;
    return row?.content_hash ?? null;
  }

  /** Record the content hash after a successful ingest (enables incremental skip). */
  setSourceHash(sourceId: number, hash: string): void {
    this.mutate(() => {
      this.db.prepare("UPDATE sources SET content_hash = ? WHERE id = ?").run(hash, sourceId);
    });
  }

  /** Number of pages produced from a given source. */
  countPagesBySource(sourceId: number): number {
    return (this.db.prepare("SELECT COUNT(*) as count FROM pages WHERE source_id = ?").get(sourceId) as any).count;
  }

  // --- Pages ---

  addPage(
    slug: string,
    title: string,
    content: string,
    sourceId?: number,
    sectionAnchor?: string,
    pageType: 'source' | 'concept' = "concept",
    displayOrder: number = 0
  ): Page {
    const page = this.mutate(() => {
      this.db
        .prepare(
          `INSERT INTO pages (slug, title, content, source_id, section_anchor, page_type, display_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET
             title = excluded.title,
             content = excluded.content,
             source_id = excluded.source_id,
             section_anchor = excluded.section_anchor,
             page_type = excluded.page_type,
             display_order = excluded.display_order,
             updated_at = datetime('now')`
        )
        .run(slug, title, content, sourceId ?? null, sectionAnchor ?? null, pageType, displayOrder);
      return this.db.prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as Page;
    });
    this.contentIndexRevision++;
    return page;
  }

  getPage(slug: string): Page | null {
    return (this.db.prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as Page) ?? null;
  }

  countPages(): number {
    return (this.db.prepare("SELECT COUNT(*) as count FROM pages").get() as any).count;
  }

  countPagesByType(pageType: 'source' | 'concept'): number {
    return (this.db.prepare("SELECT COUNT(*) as count FROM pages WHERE page_type = ?").get(pageType) as { count: number }).count;
  }

  listPages(): Page[] {
    return this.db.prepare("SELECT * FROM pages ORDER BY title").all() as Page[];
  }

  listSourcePages(): Page[] {
    return this.db
      .prepare("SELECT * FROM pages WHERE page_type = 'source' ORDER BY source_id, display_order")
      .all() as Page[];
  }

  listConceptPages(): Page[] {
    return this.db
      .prepare("SELECT * FROM pages WHERE page_type = 'concept' ORDER BY title")
      .all() as Page[];
  }

  deletePagesBySource(sourceId: number): void {
    this.mutate(() => {
      this.quizRepository.deleteQuizzesBySource(sourceId);
      // Delete links involving these pages
      this.db.prepare(
        "DELETE FROM links WHERE from_page_id IN (SELECT id FROM pages WHERE source_id = ?) OR to_page_id IN (SELECT id FROM pages WHERE source_id = ?)"
      ).run(sourceId, sourceId);
      this.citationRepository.deleteCitationsBySource(sourceId);
      // Delete figures extracted from this source
      try { this.db.prepare("DELETE FROM figures WHERE source_id = ?").run(sourceId); } catch {}
      this.db.prepare("DELETE FROM pages WHERE source_id = ?").run(sourceId);
    });
    this.contentIndexRevision++;
  }

  /** Remove only generated output for a staged attempt, preserving user pages. */
  resetIngestGeneration(sourceId: number): void {
    const reset = this.db.transaction(() => {
      const generatedPageIds =
        "SELECT id FROM pages WHERE source_id = ? AND origin = 'batch'";
      this.db.prepare(
        `DELETE FROM quiz_attempts
         WHERE quiz_id IN (SELECT id FROM quizzes WHERE page_id IN (${generatedPageIds}))`,
      ).run(sourceId);
      this.db.prepare(
        `DELETE FROM quizzes WHERE page_id IN (${generatedPageIds})`,
      ).run(sourceId);
      this.db.prepare(
        `DELETE FROM links
         WHERE from_page_id IN (${generatedPageIds})
            OR to_page_id IN (${generatedPageIds})`,
      ).run(sourceId, sourceId);
      this.db.prepare(
        `DELETE FROM citations
         WHERE page_id IN (${generatedPageIds}) OR source_id = ?`,
      ).run(sourceId, sourceId);
      this.db.prepare("DELETE FROM figures WHERE source_id = ?").run(sourceId);
      this.db.prepare(
        "DELETE FROM pages WHERE source_id = ? AND origin = 'batch'",
      ).run(sourceId);
      this.db.prepare("DELETE FROM pipeline_checkpoints WHERE source_id = ?").run(sourceId);
    });
    this.mutate(() => reset.immediate());
    this.contentIndexRevision++;
  }

  deleteAllPages(): void {
    this.mutate(() => {
      this.quizRepository.deleteAllQuizzes();
      this.db.exec("DELETE FROM links");
      this.citationRepository.deleteAllCitations();
      try { this.db.exec("DELETE FROM figures"); } catch {}
      this.db.exec("DELETE FROM pages");
    });
    this.contentIndexRevision++;
  }

  deleteAllSources(): void {
    const reset = this.db.transaction(() => {
      this.db.exec("DELETE FROM quiz_attempts");
      this.db.exec("DELETE FROM quizzes");
      this.db.exec("DELETE FROM links");
      this.db.exec("DELETE FROM citations");
      this.db.exec("DELETE FROM figures");
      this.db.exec("DELETE FROM pages");
      // Usage is accounting history, not source-owned content. Preserve it
      // while releasing the FK that would otherwise block source deletion on
      // databases created before ON DELETE SET NULL was added.
      this.db.exec("UPDATE usage_logs SET source_id = NULL");
      this.db.exec("DELETE FROM pipeline_checkpoints");
      this.db.exec("DELETE FROM sources");
    });

    this.mutate(() => reset.immediate());
    this.contentIndexRevision++;
  }

  updatePageContent(pageId: number, content: string): void {
    this.mutate(() => {
      this.db.prepare("UPDATE pages SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, pageId);
    });
  }

  /**
   * Persist user-authored content while marking generated batch pages so a
   * later re-ingest cannot silently replace the edit. Pipeline transforms must
   * continue to use updatePageContent instead.
   */
  updatePageContentAsManualEdit(pageId: number, content: string): void {
    this.mutate(() => {
      this.db.prepare(
        `UPDATE pages SET content = ?,
           manual_revision = manual_revision + CASE
             WHEN origin = 'batch' AND content <> ? THEN 1 ELSE 0 END,
           updated_at = datetime('now') WHERE id = ?`,
      ).run(content, content, pageId);
    });
  }

  updatePageContentBySlug(slug: string, content: string): void {
    this.mutate(() => {
      this.db.prepare("UPDATE pages SET content = ?, updated_at = datetime('now') WHERE slug = ?").run(content, slug);
    });
  }

  updatePageContentAndCitationsBySlug(
    slug: string,
    content: string,
    citations: readonly CitationInput[],
  ): void {
    this.replacePageContentAndCitationsBySlug(slug, content, citations, false);
  }

  updatePageContentAndCitationsBySlugAsManualEdit(
    slug: string,
    content: string,
    citations: readonly CitationInput[],
  ): void {
    this.replacePageContentAndCitationsBySlug(slug, content, citations, true);
  }

  private replacePageContentAndCitationsBySlug(
    slug: string,
    content: string,
    citations: readonly CitationInput[],
    markManualRevision: boolean,
  ): void {
    const update = this.db.prepare(
      `UPDATE pages SET content = ?,
         manual_revision = manual_revision + CASE WHEN ? AND origin = 'batch' THEN 1 ELSE 0 END,
         updated_at = datetime('now') WHERE slug = ?`,
    );
    const remove = this.db.prepare(
      "DELETE FROM citations WHERE page_id = (SELECT id FROM pages WHERE slug = ?)",
    );
    const insert = this.db.prepare(
      `INSERT INTO citations (page_id, source_id, source_page_id, excerpt, context)
       SELECT id, ?, ?, ?, ? FROM pages WHERE slug = ?`,
    );
    const replace = this.db.transaction(() => {
      update.run(content, markManualRevision ? 1 : 0, slug);
      remove.run(slug);
      for (const citation of citations) {
        insert.run(
          citation.sourceId,
          citation.sourcePageId ?? null,
          citation.excerpt ?? null,
          citation.context ?? null,
          slug,
        );
      }
    });

    this.mutate(() => replace.immediate());
  }

  updatePageCategory(pageId: number, category: string): void {
    this.mutate(() => {
      this.db.prepare("UPDATE pages SET category = ? WHERE id = ?").run(category, pageId);
    });
  }

  listPagesByCategory(category: string): Page[] {
    return this.db.prepare("SELECT * FROM pages WHERE category = ? ORDER BY title").all(category) as Page[];
  }

  listCategories(): Array<{ category: string; count: number }> {
    return this.db.prepare(
      "SELECT category, COUNT(*) as count FROM pages WHERE category IS NOT NULL GROUP BY category ORDER BY category"
    ).all() as Array<{ category: string; count: number }>;
  }

  addDynamicPage(slug: string, title: string, content: string, parentPageId: number, userQuestion: string): number {
    const pageId = this.mutate(() => {
      this.db.prepare(
        "INSERT INTO pages (slug, title, content, source_id, page_type, origin, user_question, parent_page_id) VALUES (?, ?, ?, NULL, 'concept', 'user', ?, ?)"
      ).run(slug, title, content, userQuestion, parentPageId);
      return (this.db.prepare("SELECT id FROM pages WHERE slug = ?").get(slug) as { id: number }).id;
    });
    this.contentIndexRevision++;
    return pageId;
  }

  /** Commit a generated user page and its parent link as one fenced unit. */
  addDynamicPageWithParentLink(
    slug: string,
    title: string,
    content: string,
    parentPageId: number,
    userQuestion: string,
  ): number {
    const commit = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO pages (slug, title, content, source_id, page_type, origin, user_question, parent_page_id) VALUES (?, ?, ?, NULL, 'concept', 'user', ?, ?)"
      ).run(slug, title, content, userQuestion, parentPageId);
      const pageId = (this.db.prepare(
        "SELECT id FROM pages WHERE slug = ?",
      ).get(slug) as { id: number }).id;
      this.db.prepare(
        "INSERT INTO links (from_page_id, to_page_id, anchor_text) VALUES (?, ?, ?)",
      ).run(parentPageId, pageId, title);
      return pageId;
    });

    const pageId = this.mutate(() => commit.immediate());
    this.contentIndexRevision++;
    return pageId;
  }

  listDynamicPages(): Page[] {
    return this.db.prepare("SELECT * FROM pages WHERE origin = 'user' ORDER BY id DESC").all() as Page[];
  }

  getDynamicPagesByParent(parentPageId: number): Page[] {
    return this.db.prepare("SELECT * FROM pages WHERE parent_page_id = ? ORDER BY id DESC").all(parentPageId) as Page[];
  }

  // --- Links ---

  addLink(fromId: number, toId: number, anchorText: string): void {
    const result = this.mutate(() => this.db
      .prepare("INSERT OR IGNORE INTO links (from_page_id, to_page_id, anchor_text) VALUES (?, ?, ?)")
      .run(fromId, toId, anchorText));
    if (result.changes > 0) this.contentIndexRevision++;
  }

  clearLinks(): void {
    const result = this.mutate(() => this.db.prepare("DELETE FROM links").run());
    if (result.changes > 0) this.contentIndexRevision++;
  }

  getBacklinks(pageId: number): Page[] {
    return this.db
      .prepare(
        `SELECT p.* FROM pages p JOIN links l ON l.from_page_id = p.id WHERE l.to_page_id = ? ORDER BY p.title`
      )
      .all(pageId) as Page[];
  }

  getForwardLinks(pageId: number): Page[] {
    return this.db
      .prepare(
        `SELECT p.* FROM pages p JOIN links l ON l.to_page_id = p.id WHERE l.from_page_id = ? ORDER BY p.title LIMIT 10`
      )
      .all(pageId) as Page[];
  }

  getAllLinks(): Link[] {
    return this.db.prepare("SELECT * FROM links").all() as Link[];
  }

  countLinks(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM links").get() as any).c;
  }

  getAllBacklinksGrouped(): Map<number, Array<{id: number; slug: string; title: string; page_type: 'source' | 'concept'}>> {
    const rows = this.db.prepare(`
      SELECT l.to_page_id, p.id, p.slug, p.title, p.page_type
      FROM links l
      JOIN pages p ON p.id = l.from_page_id
      ORDER BY l.to_page_id
    `).all() as Array<{to_page_id: number; id: number; slug: string; title: string; page_type: 'source' | 'concept'}>;

    const map = new Map<number, Array<{id: number; slug: string; title: string; page_type: 'source' | 'concept'}>>();
    for (const row of rows) {
      if (!map.has(row.to_page_id)) map.set(row.to_page_id, []);
      map.get(row.to_page_id)!.push({ id: row.id, slug: row.slug, title: row.title, page_type: row.page_type });
    }
    return map;
  }

  // --- Quizzes ---

  addQuiz(pageId: number, question: string, answer: string, quizType: string, explanation: string = ""): void {
    this.quizRepository.addQuiz(pageId, question, answer, quizType, explanation);
  }

  getQuizzesByPage(pageId: number): Quiz[] {
    return this.quizRepository.getQuizzesByPage(pageId);
  }

  getAllQuizzes(): Quiz[] {
    return this.quizRepository.getAllQuizzes();
  }

  getRandomQuizzes(count: number): Quiz[] {
    return this.quizRepository.getRandomQuizzes(count);
  }

  deleteQuizzesByPage(pageId: number): void {
    this.quizRepository.deleteQuizzesByPage(pageId);
  }

  getSmartQuizzes(count: number): Quiz[] {
    return this.quizRepository.getSmartQuizzes(count);
  }

  // --- SM-2 Spaced Repetition ---

  updateQuizSRS(quizId: number, quality: number): void {
    this.quizRepository.updateQuizSRS(quizId, quality);
  }

  getLearningStats(): LearningStats {
    return this.quizRepository.getLearningStats();
  }

  getWeakConcepts(limit: number): WeakConcept[] {
    return this.quizRepository.getWeakConcepts(limit);
  }

  // --- Quiz Attempts ---

  addQuizAttempt(quizId: number, isCorrect: boolean): void {
    this.quizRepository.addQuizAttempt(quizId, isCorrect);
  }

  getQuizStats(): QuizStats {
    return this.quizRepository.getQuizStats();
  }

  getWeakQuizzes(limit: number): Quiz[] {
    return this.quizRepository.getWeakQuizzes(limit);
  }

  getQuizHistory(limit: number): QuizHistoryEntry[] {
    return this.quizRepository.getQuizHistory(limit);
  }

  // --- Usage ---

  addUsageLog(sourceId: number | null, calls: number, prompt: number, completion: number, total: number, cost: number): void {
    this.activityRepository.addUsageLog(sourceId, calls, prompt, completion, total, cost);
  }

  getUsageSummary(): UsageSummary {
    return this.activityRepository.getUsageSummary();
  }

  // --- Pipeline Checkpoints ---

  setCheckpoint(sourceId: number, phase: string, batchIndex: number = 0, inputHash?: string): void {
    this.mutate(() => {
      this.db.prepare(
        `INSERT OR REPLACE INTO pipeline_checkpoints
           (source_id, phase, batch_index, status, input_hash)
         VALUES (?, ?, ?, 'completed', ?)`
      ).run(sourceId, phase, batchIndex, inputHash ?? null);
    });
  }

  getLastCompletedBatch(sourceId: number, phase: string): number {
    const row = this.db.prepare(
      "SELECT MAX(batch_index) as last_batch FROM pipeline_checkpoints WHERE source_id = ? AND phase = ? AND status = 'completed'"
    ).get(sourceId, phase) as { last_batch: number | null } | undefined;
    return row?.last_batch ?? -1;
  }

  hasPhaseCheckpoint(sourceId: number, phase: string): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM pipeline_checkpoints WHERE source_id = ? AND phase = ? AND status = 'completed'"
    ).get(sourceId, phase) as { cnt: number };
    return row.cnt > 0;
  }

  hasCheckpoints(sourceId: number): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM pipeline_checkpoints WHERE source_id = ?"
    ).get(sourceId) as { cnt: number };
    return row.cnt > 0;
  }

  /** True only when every resumable row belongs to this exact source input. */
  checkpointsMatchInput(sourceId: number, inputHash: string): boolean {
    const row = this.db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN input_hash = ? THEN 1 ELSE 0 END) as matching
       FROM pipeline_checkpoints WHERE source_id = ?`
    ).get(inputHash, sourceId) as { total: number; matching: number | null };
    return row.total > 0 && row.matching === row.total;
  }

  clearCheckpoints(sourceId: number): void {
    this.mutate(() => {
      this.db.prepare("DELETE FROM pipeline_checkpoints WHERE source_id = ?").run(sourceId);
    });
  }

  searchPages(query: string, limit: number = 5): Array<{slug: string; title: string; page_type: 'source' | 'concept'; origin: string; preview: string; rank: number}> {
    const words = query.split(/\s+/).filter(w => w.length >= 2);
    if (!words.length) return [];

    try {
      // Try FTS5 search first (much better relevance)
      const ftsQuery = words.map(w => `"${w.replace(/"/g, "")}"`)
.join(' OR ');
      if (!ftsQuery) return [];

      const results = this.db.prepare(`
        SELECT p.slug, p.title, p.page_type, p.origin,
               substr(p.content, 1, 200) as preview,
               rank
        FROM pages_fts f
        JOIN pages p ON p.id = f.rowid
        WHERE pages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];
      if (results.length > 0) return results;
    } catch {
      // Fall through to LIKE when FTS5 is unavailable or rejects the query.
    }

    // FTS token matching does not find substrings within a Korean token. Use a
    // bounded LIKE fallback when the FTS query produced no rows.
    const conditions = words.map(() => "(title LIKE ? OR content LIKE ?)").join(" OR ");
    const params = words.flatMap(w => [`%${w}%`, `%${w}%`]);
    return this.db.prepare(`
      SELECT slug, title, page_type, origin, substr(content, 1, 200) as preview, 0 as rank
      FROM pages WHERE ${conditions}
      ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END
      LIMIT ?
    `).all(...params, `%${query}%`, limit) as any[];
  }

  // --- Embeddings ---

  saveEmbedding(pageId: number, embedding: Float32Array, model: string): void {
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.mutate(() => {
      this.db.prepare(
        "INSERT OR REPLACE INTO page_embeddings (page_id, embedding, model) VALUES (?, ?, ?)"
      ).run(pageId, buffer, model);
    });
  }

  getEmbedding(pageId: number): Float32Array | null {
    const row = this.db.prepare("SELECT embedding FROM page_embeddings WHERE page_id = ?").get(pageId) as any;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer);
  }

  getAllEmbeddings(model?: string): Array<{pageId: number; slug: string; title: string; pageType: string; origin: string; embedding: Float32Array}> {
    const rows = this.db.prepare(`
      SELECT e.page_id, e.embedding, p.slug, p.title, p.page_type, p.origin
      FROM page_embeddings e
      JOIN pages p ON p.id = e.page_id
      WHERE (? IS NULL OR e.model = ?)
    `).all(model ?? null, model ?? null) as any[];
    return rows.map(r => ({
      pageId: r.page_id,
      slug: r.slug,
      title: r.title,
      pageType: r.page_type,
      origin: r.origin,
      embedding: new Float32Array(r.embedding.buffer)
    }));
  }

  getPagesWithoutEmbeddings(model?: string): Array<{id: number; title: string; content: string}> {
    return this.db.prepare(`
      SELECT p.id, p.title, p.content
      FROM pages p
      LEFT JOIN page_embeddings e ON e.page_id = p.id
      WHERE e.page_id IS NULL OR (? IS NOT NULL AND e.model != ?)
    `).all(model ?? null, model ?? null) as any[];
  }

  /** Find a page with a very similar title (normalized: lowercase, trimmed, no punctuation) */
  findSimilarPage(title: string): Page | null {
    const normalized = normalizeTitle(title);
    if (!normalized) return null;

    const rows = this.db.prepare("SELECT id, slug, title FROM pages WHERE page_type = 'concept'")
      .all() as Array<{ id: number; slug: string; title: string }>;
    for (const row of rows) {
      if (normalizeTitle(row.title) === normalized) {
        // Fetch the full page only for the match
        return this.getPage(row.slug);
      }
    }
    return null;
  }

  // --- RAG chunks (chunk-level vector store for ask-the-wiki) ---

  /** Current content hash stored for a page's chunks, or null if never chunked. */
  getChunkContentHash(pageId: number): string | null {
    const row = this.db.prepare(
      "SELECT content_hash FROM page_chunks WHERE page_id = ? LIMIT 1"
    ).get(pageId) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  /** Replace all chunks for a page. Embeddings are cleared (must be regenerated). */
  replaceChunks(pageId: number, chunks: string[], contentHash: string): number[] {
    return this.mutate(() => {
      const tx = this.db.transaction(() => {
        this.db.prepare("DELETE FROM page_chunks WHERE page_id = ?").run(pageId);
        const insert = this.db.prepare(
          "INSERT INTO page_chunks (page_id, chunk_index, content, content_hash) VALUES (?, ?, ?, ?)"
        );
        const ids: number[] = [];
        for (let i = 0; i < chunks.length; i++) {
          insert.run(pageId, i, chunks[i], contentHash);
          ids.push((this.db.prepare("SELECT last_insert_rowid() as id").get() as any).id);
        }
        return ids;
      });
      return tx();
    });
  }

  /** Delete chunks for pages that no longer exist (safety; FK cascade usually handles it). */
  deleteOrphanChunks(): void {
    this.mutate(() => {
      this.db.exec("DELETE FROM page_chunks WHERE page_id NOT IN (SELECT id FROM pages)");
    });
  }

  saveChunkEmbedding(chunkId: number, embedding: Float32Array, model: string): void {
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.mutate(() => {
      this.db.prepare("UPDATE page_chunks SET embedding = ?, model = ? WHERE id = ?")
        .run(buffer, model, chunkId);
    });
  }

  /** Chunks that still need an embedding generated. */
  getChunksWithoutEmbedding(model?: string): Array<{ id: number; page_id: number; content: string; title: string }> {
    return this.db.prepare(`
      SELECT c.id, c.page_id, c.content, p.title
      FROM page_chunks c JOIN pages p ON p.id = c.page_id
      WHERE c.embedding IS NULL OR (? IS NOT NULL AND (c.model IS NULL OR c.model != ?))
      ORDER BY c.id
    `).all(model ?? null, model ?? null) as any[];
  }

  /** All chunk embeddings joined with page metadata, for retrieval ranking. */
  getAllChunkEmbeddings(model?: string): ChunkEmbeddingRow[] {
    const rows = this.db.prepare(`
      SELECT c.id, c.page_id, c.chunk_index, c.content, c.embedding,
             p.slug, p.title, p.page_type
      FROM page_chunks c JOIN pages p ON p.id = c.page_id
      WHERE c.embedding IS NOT NULL AND (? IS NULL OR c.model = ?)
    `).all(model ?? null, model ?? null) as any[];
    return rows.map(r => ({
      chunkId: r.id,
      pageId: r.page_id,
      chunkIndex: r.chunk_index,
      slug: r.slug,
      title: r.title,
      content: r.content,
      pageType: r.page_type,
      embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
    }));
  }

  countChunks(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM page_chunks").get() as any).c;
  }

  countChunkEmbeddings(model?: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) as c FROM page_chunks WHERE embedding IS NOT NULL AND (? IS NULL OR model = ?)"
    ).get(model ?? null, model ?? null) as any).c;
  }

  getSourcePages(sourceId: number): Page[] {
    return this.db.prepare(
      "SELECT * FROM pages WHERE source_id = ? AND page_type = 'source' ORDER BY display_order"
    ).all(sourceId) as Page[];
  }

  // --- Activity Log ---

  addActivityLog(
    action: string,
    title: string,
    entityType?: string,
    entityId?: number,
    details?: Record<string, unknown>,
  ): void {
    this.activityRepository.addActivityLog(action, title, entityType, entityId, details);
  }

  getActivityLog(limit: number = 50, offset: number = 0, action?: string): ActivityLogEntry[] {
    return this.activityRepository.getActivityLog(limit, offset, action);
  }

  getActivityStats(): ActivityStats {
    return this.activityRepository.getActivityStats();
  }

  // --- Content Index ---

  getPagesBySource(): Array<{
    sourceId: number;
    sourceTitle: string;
    pages: Array<{ id: number; title: string; slug: string; page_type: 'source' | 'concept'; linkCount: number }>;
  }> {
    const rows = this.db.prepare(`
      SELECT p.id, p.title, p.slug, p.page_type, p.source_id,
             COALESCE(s.title, '미분류') as source_title,
             COALESCE(lc.cnt, 0) as link_count
      FROM pages p
      LEFT JOIN sources s ON s.id = p.source_id
      LEFT JOIN (
        SELECT page_id, COUNT(*) as cnt FROM (
          SELECT from_page_id as page_id FROM links
          UNION ALL
          SELECT to_page_id as page_id FROM links
        ) GROUP BY page_id
      ) lc ON lc.page_id = p.id
      ORDER BY COALESCE(s.title, 'zzz'), p.display_order, p.title
    `).all() as Array<{
      id: number; title: string; slug: string; page_type: 'source' | 'concept';
      source_id: number | null; source_title: string; link_count: number;
    }>;

    const groupMap = new Map<number | -1, {
      sourceId: number;
      sourceTitle: string;
      pages: Array<{ id: number; title: string; slug: string; page_type: 'source' | 'concept'; linkCount: number }>;
    }>();

    for (const row of rows) {
      const key = row.source_id ?? -1;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          sourceId: row.source_id ?? -1,
          sourceTitle: row.source_title,
          pages: [],
        });
      }
      groupMap.get(key)!.pages.push({
        id: row.id,
        title: row.title,
        slug: row.slug,
        page_type: row.page_type,
        linkCount: row.link_count,
      });
    }

    return Array.from(groupMap.values());
  }

  // --- Citations ---

  addCitation(pageId: number, sourceId: number, sourcePageId?: number, excerpt?: string, context?: string): number {
    return this.citationRepository.addCitation(pageId, sourceId, sourcePageId, excerpt, context);
  }

  replaceCitations(pageId: number, citations: readonly CitationInput[]): number[] {
    return this.citationRepository.replaceCitations(pageId, citations);
  }

  getCitationsForPage(pageId: number): Citation[] {
    return this.citationRepository.getCitationsForPage(pageId);
  }

  getCitationsForSource(sourceId: number): Citation[] {
    return this.citationRepository.getCitationsForSource(sourceId);
  }

  getSourceCoverage(): SourceCoverage[] {
    return this.citationRepository.getSourceCoverage();
  }

  deleteCitationsForPage(pageId: number): void {
    this.citationRepository.deleteCitationsForPage(pageId);
  }

  getSourceById(id: number): Source | null {
    return (this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Source) ?? null;
  }

  getPageById(id: number): Page | null {
    return (this.db.prepare("SELECT * FROM pages WHERE id = ?").get(id) as Page) ?? null;
  }

  /** Update origin metadata for a page (used by promote). */
  updatePageOrigin(slug: string, origin: string, userQuestion: string, parentPageId: number): void {
    this.mutate(() => {
      this.db
        .prepare("UPDATE pages SET origin = ?, user_question = ?, parent_page_id = ? WHERE slug = ?")
        .run(origin, userQuestion, parentPageId, slug);
    });
  }

  /** Return lightweight page summaries (no content) for wiki-linking. */
  listPageSummaries(): Array<{ id: number; slug: string; title: string }> {
    return this.db.prepare("SELECT id, slug, title FROM pages ORDER BY title").all() as Array<{
      id: number;
      slug: string;
      title: string;
    }>;
  }

  // --- Figures ---

  addFigure(sourceId: number, imagePath: string, pageId?: number | null, caption?: string | null, pageNumber?: number | null): number {
    return this.mutate(() => {
      this.db.prepare(
        "INSERT INTO figures (source_id, page_id, image_path, caption, page_number) VALUES (?, ?, ?, ?, ?)"
      ).run(sourceId, pageId ?? null, imagePath, caption ?? null, pageNumber ?? null);
      return (this.db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    });
  }

  listFiguresBySource(sourceId: number): Figure[] {
    return this.db.prepare("SELECT * FROM figures WHERE source_id = ? ORDER BY page_number, id").all(sourceId) as Figure[];
  }

  listFiguresByPage(pageId: number): Figure[] {
    return this.db.prepare("SELECT * FROM figures WHERE page_id = ? ORDER BY id").all(pageId) as Figure[];
  }

  /** Public figure paths only, without captions or other row metadata. */
  listFigurePaths(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT image_path FROM figures ORDER BY image_path",
    ).all() as Array<{ image_path: string }>;
    return rows.map((row) => row.image_path);
  }

  deleteFiguresBySource(sourceId: number): void {
    this.mutate(() => {
      this.db.prepare("DELETE FROM figures WHERE source_id = ?").run(sourceId);
    });
  }

  countFigures(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM figures").get() as any).c;
  }
}
