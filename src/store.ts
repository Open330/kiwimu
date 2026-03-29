import { Database } from "bun:sqlite";

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
  page_type: string; // 'source' | 'concept'
  display_order: number;
  origin: string; // 'batch' | 'user'
  user_question: string | null;
  parent_page_id: number | null;
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
CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
  source_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  batch_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, phase, batch_index)
);
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
    // SM-2 spaced repetition columns
    try { this.db.exec("ALTER TABLE quizzes ADD COLUMN ease_factor REAL NOT NULL DEFAULT 2.5"); } catch {}
    try { this.db.exec("ALTER TABLE quizzes ADD COLUMN interval INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE quizzes ADD COLUMN next_review_at TEXT DEFAULT NULL"); } catch {}
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
    pageType: string = "concept",
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
    this.db.prepare("DELETE FROM pages WHERE source_id = ?").run(sourceId);
  }

  deleteAllPages(): void {
    this.db.exec("DELETE FROM quiz_attempts");
    this.db.exec("DELETE FROM quizzes");
    this.db.exec("DELETE FROM links");
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

  getAllBacklinksGrouped(): Map<number, Array<{id: number; slug: string; title: string; page_type: string}>> {
    const rows = this.db.prepare(`
      SELECT l.to_page_id, p.id, p.slug, p.title, p.page_type
      FROM links l
      JOIN pages p ON p.id = l.from_page_id
      ORDER BY l.to_page_id
    `).all() as Array<{to_page_id: number; id: number; slug: string; title: string; page_type: string}>;

    const map = new Map<number, Array<{id: number; slug: string; title: string; page_type: string}>>();
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

  isPhaseComplete(sourceId: number, phase: string): boolean {
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

  getSourcePages(sourceId: number): Page[] {
    return this.db.prepare(
      "SELECT * FROM pages WHERE source_id = ? AND page_type = 'source' ORDER BY display_order"
    ).all(sourceId) as Page[];
  }
}
