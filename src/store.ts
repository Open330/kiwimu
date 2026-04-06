import { Database } from "bun:sqlite";
import { normalizeTitle } from "./utils";

export interface Source {
  id: number;
  uri: string;
  type: string;
  title: string;
  raw_content: string;
  fetched_at: string;
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

export interface Link {
  from_page_id: number;
  to_page_id: number;
  anchor_text: string;
}

export interface Citation {
  id: number;
  page_id: number;
  source_id: number;
  source_page_id: number | null;
  excerpt: string | null;
  context: string | null;
  created_at: string;
  // Joined fields (optional, populated by queries)
  source_title?: string;
  source_page_title?: string;
  source_page_slug?: string;
  page_title?: string;
  page_slug?: string;
}

export interface Quiz {
  id: number;
  page_id: number;
  question: string;
  answer: string;
  explanation: string;
  quiz_type: string; // 'fill_blank' | 'ox' | 'short_answer'
  ease_factor: number;
  interval: number;
  next_review_at: string | null;
  created_at: string;
  page_title?: string;
  page_slug?: string;
}

export interface ActivityLogEntry {
  id: number;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  title: string;
  details: string | null;
  created_at: string;
}

export interface SourceCoverage {
  sourceId: number;
  sourceTitle: string;
  citationCount: number;
  pageCount: number;
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
  user_question TEXT DEFAULT NULL,
  parent_page_id INTEGER DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id),
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
CREATE INDEX IF NOT EXISTS idx_pages_origin ON pages(origin);
CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_page_id);
CREATE INDEX IF NOT EXISTS idx_pages_category ON pages(category);
CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
  source_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  batch_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, phase, batch_index)
);
CREATE TABLE IF NOT EXISTS page_embeddings (
  page_id INTEGER PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
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

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initSchema();
  }

  initSchema(): void {
    this.db.exec(SCHEMA);
    // Migrate: add explanation column if missing (for existing databases)
    try {
      this.db.exec("ALTER TABLE quizzes ADD COLUMN explanation TEXT DEFAULT ''");
    } catch {
      // Column already exists — ignore
    }
    try { this.db.exec("ALTER TABLE pages ADD COLUMN origin TEXT NOT NULL DEFAULT 'batch'"); } catch {}
    try { this.db.exec("ALTER TABLE pages ADD COLUMN user_question TEXT DEFAULT NULL"); } catch {}
    try { this.db.exec("ALTER TABLE pages ADD COLUMN parent_page_id INTEGER DEFAULT NULL"); } catch {}
    try { this.db.exec("ALTER TABLE pages ADD COLUMN category TEXT DEFAULT NULL"); } catch {}
    // SM-2 spaced repetition columns
    try { this.db.exec("ALTER TABLE quizzes ADD COLUMN ease_factor REAL NOT NULL DEFAULT 2.5"); } catch {}
    try { this.db.exec("ALTER TABLE quizzes ADD COLUMN interval INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE quizzes ADD COLUMN next_review_at TEXT DEFAULT NULL"); } catch {}
    // FTS5 full-text search (may not be available in older SQLite builds)
    try { this.db.exec(FTS_SCHEMA); } catch {}
    this.rebuildFtsIndex();
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

  // --- Sources ---

  addSource(uri: string, type: string, title: string, rawContent: string): Source {
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
  }

  getPage(slug: string): Page | null {
    return (this.db.prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as Page) ?? null;
  }

  countPages(): number {
    return (this.db.prepare("SELECT COUNT(*) as count FROM pages").get() as any).count;
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
    // Delete quiz attempts for quizzes on these pages first
    this.db.prepare(
      "DELETE FROM quiz_attempts WHERE quiz_id IN (SELECT id FROM quizzes WHERE page_id IN (SELECT id FROM pages WHERE source_id = ?))"
    ).run(sourceId);
    // Delete quizzes for these pages
    this.db.prepare(
      "DELETE FROM quizzes WHERE page_id IN (SELECT id FROM pages WHERE source_id = ?)"
    ).run(sourceId);
    // Delete links involving these pages
    this.db.prepare(
      "DELETE FROM links WHERE from_page_id IN (SELECT id FROM pages WHERE source_id = ?) OR to_page_id IN (SELECT id FROM pages WHERE source_id = ?)"
    ).run(sourceId, sourceId);
    // Delete citations involving these pages
    this.db.prepare(
      "DELETE FROM citations WHERE page_id IN (SELECT id FROM pages WHERE source_id = ?) OR source_id = ?"
    ).run(sourceId, sourceId);
    this.db.prepare("DELETE FROM pages WHERE source_id = ?").run(sourceId);
  }

  deleteAllPages(): void {
    this.db.exec("DELETE FROM quiz_attempts");
    this.db.exec("DELETE FROM quizzes");
    this.db.exec("DELETE FROM links");
    this.db.exec("DELETE FROM citations");
    this.db.exec("DELETE FROM pages");
  }

  deleteAllSources(): void {
    this.deleteAllPages();
    this.db.exec("DELETE FROM sources");
  }

  updatePageContent(pageId: number, content: string): void {
    this.db.prepare("UPDATE pages SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, pageId);
  }

  updatePageContentBySlug(slug: string, content: string): void {
    this.db.prepare("UPDATE pages SET content = ?, updated_at = datetime('now') WHERE slug = ?").run(content, slug);
  }

  updatePageCategory(pageId: number, category: string): void {
    this.db.prepare("UPDATE pages SET category = ? WHERE id = ?").run(category, pageId);
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
    this.db.prepare(
      "INSERT INTO pages (slug, title, content, source_id, page_type, origin, user_question, parent_page_id) VALUES (?, ?, ?, NULL, 'concept', 'user', ?, ?)"
    ).run(slug, title, content, userQuestion, parentPageId);
    return (this.db.prepare("SELECT id FROM pages WHERE slug = ?").get(slug) as any).id;
  }

  listDynamicPages(): Page[] {
    return this.db.prepare("SELECT * FROM pages WHERE origin = 'user' ORDER BY id DESC").all() as Page[];
  }

  getDynamicPagesByParent(parentPageId: number): Page[] {
    return this.db.prepare("SELECT * FROM pages WHERE parent_page_id = ? ORDER BY id DESC").all(parentPageId) as Page[];
  }

  // --- Links ---

  addLink(fromId: number, toId: number, anchorText: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO links (from_page_id, to_page_id, anchor_text) VALUES (?, ?, ?)")
      .run(fromId, toId, anchorText);
  }

  clearLinks(): void {
    this.db.exec("DELETE FROM links");
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
    this.db
      .prepare("INSERT INTO quizzes (page_id, question, answer, explanation, quiz_type) VALUES (?, ?, ?, ?, ?)")
      .run(pageId, question, answer, explanation, quizType);
  }

  getQuizzesByPage(pageId: number): Quiz[] {
    return this.db
      .prepare(
        `SELECT q.*, p.title as page_title, p.slug as page_slug
         FROM quizzes q JOIN pages p ON p.id = q.page_id
         WHERE q.page_id = ? ORDER BY q.id`
      )
      .all(pageId) as Quiz[];
  }

  getAllQuizzes(): Quiz[] {
    return this.db
      .prepare(
        `SELECT q.*, p.title as page_title, p.slug as page_slug
         FROM quizzes q JOIN pages p ON p.id = q.page_id
         ORDER BY q.id`
      )
      .all() as Quiz[];
  }

  getRandomQuizzes(count: number): Quiz[] {
    return this.db
      .prepare(
        `SELECT q.*, p.title as page_title, p.slug as page_slug
         FROM quizzes q JOIN pages p ON p.id = q.page_id
         ORDER BY RANDOM() LIMIT ?`
      )
      .all(count) as Quiz[];
  }

  deleteQuizzesByPage(pageId: number): void {
    this.db.prepare("DELETE FROM quizzes WHERE page_id = ?").run(pageId);
  }

  getSmartQuizzes(count: number): Quiz[] {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT q.*, p.title as page_title, p.slug as page_slug
      FROM quizzes q
      JOIN pages p ON p.id = q.page_id
      WHERE q.next_review_at IS NULL OR q.next_review_at <= ?
      ORDER BY
        CASE WHEN q.next_review_at IS NULL THEN 0 ELSE 1 END,
        q.next_review_at ASC
      LIMIT ?
    `).all(now, count) as Quiz[];
  }

  // --- SM-2 Spaced Repetition ---

  updateQuizSRS(quizId: number, quality: number): void {
    // quality: 0-5 (0=total blackout, 5=perfect)
    const quiz = this.db.prepare("SELECT ease_factor, interval FROM quizzes WHERE id = ?").get(quizId) as any;
    if (!quiz) return;

    let ef = quiz.ease_factor;
    let interval = quiz.interval;

    if (quality >= 3) {
      // Correct answer
      if (interval === 0) interval = 1;
      else if (interval === 1) interval = 6;
      else interval = Math.round(interval * ef);

      ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    } else {
      // Wrong answer - reset
      interval = 0;
      // ef stays the same
    }

    if (ef < 1.3) ef = 1.3;

    const nextReview = new Date();
    nextReview.setDate(nextReview.getDate() + interval);

    this.db.prepare(
      "UPDATE quizzes SET ease_factor = ?, interval = ?, next_review_at = ? WHERE id = ?"
    ).run(ef, interval, nextReview.toISOString(), quizId);
  }

  getLearningStats(): { total: number; mastered: number; learning: number; new: number; dueToday: number } {
    const now = new Date().toISOString();
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM quizzes").get() as any).c;
    const mastered = (this.db.prepare("SELECT COUNT(*) as c FROM quizzes WHERE interval >= 21").get() as any).c;
    const newQ = (this.db.prepare("SELECT COUNT(*) as c FROM quizzes WHERE next_review_at IS NULL").get() as any).c;
    const due = (this.db.prepare("SELECT COUNT(*) as c FROM quizzes WHERE next_review_at <= ?").get(now) as any).c;
    return { total, mastered, learning: total - mastered - newQ, new: newQ, dueToday: due };
  }

  getWeakConcepts(limit: number): Array<{title: string; slug: string; wrongCount: number}> {
    return this.db.prepare(`
      SELECT p.title, p.slug, COUNT(qa.id) as wrongCount
      FROM quiz_attempts qa
      JOIN quizzes q ON q.id = qa.quiz_id
      JOIN pages p ON p.id = q.page_id
      WHERE qa.is_correct = 0
      GROUP BY p.id
      ORDER BY wrongCount DESC
      LIMIT ?
    `).all(limit) as any[];
  }

  // --- Quiz Attempts ---

  addQuizAttempt(quizId: number, isCorrect: boolean): void {
    this.db
      .prepare("INSERT INTO quiz_attempts (quiz_id, is_correct) VALUES (?, ?)")
      .run(quizId, isCorrect ? 1 : 0);
    const quiz = this.db.prepare("SELECT question FROM quizzes WHERE id = ?").get(quizId) as { question: string } | undefined;
    if (quiz) {
      this.addActivityLog('quiz_attempted', `Answered quiz: ${quiz.question.slice(0, 80)}`, 'quiz', quizId, { is_correct: isCorrect });
    }
  }

  getQuizStats(): { total: number; correct: number; incorrect: number; unattempted: number } {
    const totalQuizzes = (this.db.prepare("SELECT COUNT(*) as cnt FROM quizzes").get() as { cnt: number }).cnt;
    const attemptRow = this.db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct,
        SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) as incorrect
      FROM quiz_attempts
    `).get() as { total: number; correct: number; incorrect: number };
    const attemptedQuizzes = (this.db.prepare("SELECT COUNT(DISTINCT quiz_id) as cnt FROM quiz_attempts").get() as { cnt: number }).cnt;
    return {
      total: attemptRow.total,
      correct: attemptRow.correct,
      incorrect: attemptRow.incorrect,
      unattempted: totalQuizzes - attemptedQuizzes,
    };
  }

  getWeakQuizzes(limit: number): Quiz[] {
    return this.db.prepare(`
      SELECT q.*, p.title as page_title, p.slug as page_slug
      FROM quizzes q
      JOIN pages p ON p.id = q.page_id
      LEFT JOIN (
        SELECT quiz_id,
          SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) as wrong_count,
          COUNT(*) as attempt_count
        FROM quiz_attempts
        GROUP BY quiz_id
      ) a ON a.quiz_id = q.id
      ORDER BY
        CASE WHEN a.attempt_count IS NULL THEN 1 ELSE 0 END DESC,
        COALESCE(a.wrong_count, 0) DESC
      LIMIT ?
    `).all(limit) as Quiz[];
  }

  getQuizHistory(limit: number): Array<{ quiz_id: number; question: string; is_correct: boolean; attempted_at: string }> {
    return this.db.prepare(`
      SELECT qa.quiz_id, q.question, qa.is_correct, qa.attempted_at
      FROM quiz_attempts qa
      JOIN quizzes q ON q.id = qa.quiz_id
      ORDER BY qa.attempted_at DESC
      LIMIT ?
    `).all(limit).map((row: any) => ({
      quiz_id: row.quiz_id,
      question: row.question,
      is_correct: row.is_correct === 1,
      attempted_at: row.attempted_at,
    }));
  }

  // --- Usage ---

  addUsageLog(sourceId: number | null, calls: number, prompt: number, completion: number, total: number, cost: number): void {
    this.db
      .prepare("INSERT INTO usage_logs (source_id, llm_calls, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sourceId, calls, prompt, completion, total, cost);
  }

  getUsageSummary(): { totalCalls: number; promptTokens: number; completionTokens: number; totalTokens: number; totalCost: number } {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(llm_calls),0) as totalCalls, COALESCE(SUM(prompt_tokens),0) as promptTokens, COALESCE(SUM(completion_tokens),0) as completionTokens, COALESCE(SUM(total_tokens),0) as totalTokens, COALESCE(SUM(estimated_cost_usd),0) as totalCost FROM usage_logs"
    ).get() as { totalCalls: number; promptTokens: number; completionTokens: number; totalTokens: number; totalCost: number };
    return row;
  }

  // --- Pipeline Checkpoints ---

  setCheckpoint(sourceId: number, phase: string, batchIndex: number = 0): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO pipeline_checkpoints (source_id, phase, batch_index, status) VALUES (?, ?, ?, 'completed')"
    ).run(sourceId, phase, batchIndex);
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

  clearCheckpoints(sourceId: number): void {
    this.db.prepare("DELETE FROM pipeline_checkpoints WHERE source_id = ?").run(sourceId);
  }

  searchPages(query: string, limit: number = 5): Array<{slug: string; title: string; page_type: 'source' | 'concept'; origin: string; preview: string; rank: number}> {
    try {
      // Try FTS5 search first (much better relevance)
      const ftsQuery = query.split(/\s+/).filter(w => w.length >= 2).map(w => `"${w.replace(/"/g, "")}"`)
.join(' OR ');
      if (!ftsQuery) return [];

      return this.db.prepare(`
        SELECT p.slug, p.title, p.page_type, p.origin,
               substr(p.content, 1, 200) as preview,
               rank
        FROM pages_fts f
        JOIN pages p ON p.id = f.rowid
        WHERE pages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];
    } catch {
      // Fallback to LIKE search if FTS not available
      const words = query.split(/\s+/).filter(w => w.length >= 2);
      if (!words.length) return [];
      const conditions = words.map(() => "(title LIKE ? OR content LIKE ?)").join(" OR ");
      const params = words.flatMap(w => [`%${w}%`, `%${w}%`]);
      return this.db.prepare(`
        SELECT slug, title, page_type, origin, substr(content, 1, 200) as preview, 0 as rank
        FROM pages WHERE ${conditions}
        ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END
        LIMIT ?
      `).all(...params, `%${query}%`, limit) as any[];
    }
  }

  // --- Embeddings ---

  saveEmbedding(pageId: number, embedding: Float32Array, model: string): void {
    const buffer = Buffer.from(embedding.buffer);
    this.db.prepare(
      "INSERT OR REPLACE INTO page_embeddings (page_id, embedding, model) VALUES (?, ?, ?)"
    ).run(pageId, buffer, model);
  }

  getEmbedding(pageId: number): Float32Array | null {
    const row = this.db.prepare("SELECT embedding FROM page_embeddings WHERE page_id = ?").get(pageId) as any;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer);
  }

  getAllEmbeddings(): Array<{pageId: number; slug: string; title: string; pageType: string; origin: string; embedding: Float32Array}> {
    const rows = this.db.prepare(`
      SELECT e.page_id, e.embedding, p.slug, p.title, p.page_type, p.origin
      FROM page_embeddings e
      JOIN pages p ON p.id = e.page_id
    `).all() as any[];
    return rows.map(r => ({
      pageId: r.page_id,
      slug: r.slug,
      title: r.title,
      pageType: r.page_type,
      origin: r.origin,
      embedding: new Float32Array(r.embedding.buffer)
    }));
  }

  getPagesWithoutEmbeddings(): Array<{id: number; title: string; content: string}> {
    return this.db.prepare(`
      SELECT p.id, p.title, p.content
      FROM pages p
      LEFT JOIN page_embeddings e ON e.page_id = p.id
      WHERE e.page_id IS NULL
    `).all() as any[];
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

  getSourcePages(sourceId: number): Page[] {
    return this.db.prepare(
      "SELECT * FROM pages WHERE source_id = ? AND page_type = 'source' ORDER BY display_order"
    ).all(sourceId) as Page[];
  }

  // --- Activity Log ---

  addActivityLog(action: string, title: string, entityType?: string, entityId?: number, details?: Record<string, any>): void {
    this.db.prepare(
      "INSERT INTO activity_log (action, entity_type, entity_id, title, details) VALUES (?, ?, ?, ?, ?)"
    ).run(action, entityType ?? null, entityId ?? null, title, details ? JSON.stringify(details) : null);
  }

  getActivityLog(limit: number = 50, offset: number = 0, action?: string): ActivityLogEntry[] {
    if (action) {
      return this.db.prepare(
        "SELECT * FROM activity_log WHERE action = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      ).all(action, limit, offset) as ActivityLogEntry[];
    }
    return this.db.prepare(
      "SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(limit, offset) as ActivityLogEntry[];
  }

  getActivityStats(): { total: number; byAction: Record<string, number>; recentDays: { date: string; count: number }[] } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM activity_log").get() as any).c;
    const byActionRows = this.db.prepare(
      "SELECT action, COUNT(*) as c FROM activity_log GROUP BY action"
    ).all() as Array<{ action: string; c: number }>;
    const byAction: Record<string, number> = {};
    for (const row of byActionRows) byAction[row.action] = row.c;
    const recentDays = this.db.prepare(
      "SELECT date(created_at) as date, COUNT(*) as count FROM activity_log WHERE created_at >= datetime('now', '-30 days') GROUP BY date(created_at) ORDER BY date DESC"
    ).all() as Array<{ date: string; count: number }>;
    return { total, byAction, recentDays };
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
    this.db.prepare(
      "INSERT INTO citations (page_id, source_id, source_page_id, excerpt, context) VALUES (?, ?, ?, ?, ?)"
    ).run(pageId, sourceId, sourcePageId ?? null, excerpt ?? null, context ?? null);
    return (this.db.prepare("SELECT last_insert_rowid() as id").get() as any).id;
  }

  getCitationsForPage(pageId: number): Citation[] {
    return this.db.prepare(`
      SELECT c.*,
        s.title as source_title,
        sp.title as source_page_title,
        sp.slug as source_page_slug
      FROM citations c
      JOIN sources s ON s.id = c.source_id
      LEFT JOIN pages sp ON sp.id = c.source_page_id
      WHERE c.page_id = ?
      ORDER BY c.id
    `).all(pageId) as Citation[];
  }

  getCitationsForSource(sourceId: number): Citation[] {
    return this.db.prepare(`
      SELECT c.*,
        p.title as page_title,
        p.slug as page_slug,
        sp.title as source_page_title,
        sp.slug as source_page_slug
      FROM citations c
      JOIN pages p ON p.id = c.page_id
      LEFT JOIN pages sp ON sp.id = c.source_page_id
      WHERE c.source_id = ?
      ORDER BY c.id
    `).all(sourceId) as Citation[];
  }

  getSourceCoverage(): SourceCoverage[] {
    return this.db.prepare(`
      SELECT s.id as sourceId, s.title as sourceTitle,
        COUNT(c.id) as citationCount,
        COUNT(DISTINCT c.page_id) as pageCount
      FROM sources s
      LEFT JOIN citations c ON c.source_id = s.id
      GROUP BY s.id
      ORDER BY citationCount DESC
    `).all() as SourceCoverage[];
  }

  deleteCitationsForPage(pageId: number): void {
    this.db.prepare("DELETE FROM citations WHERE page_id = ?").run(pageId);
  }

  getSourceById(id: number): Source | null {
    return (this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Source) ?? null;
  }

  getPageById(id: number): Page | null {
    return (this.db.prepare("SELECT * FROM pages WHERE id = ?").get(id) as Page) ?? null;
  }

  /** Update origin metadata for a page (used by promote). */
  updatePageOrigin(slug: string, origin: string, userQuestion: string, parentPageId: number): void {
    this.db
      .prepare("UPDATE pages SET origin = ?, user_question = ?, parent_page_id = ? WHERE slug = ?")
      .run(origin, userQuestion, parentPageId, slug);
  }

  /** Return lightweight page summaries (no content) for wiki-linking. */
  listPageSummaries(): Array<{ id: number; slug: string; title: string }> {
    return this.db.prepare("SELECT id, slug, title FROM pages ORDER BY title").all() as Array<{
      id: number;
      slug: string;
      title: string;
    }>;
  }
}
