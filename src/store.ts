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
  source_id INTEGER REFERENCES sources(id),
  section_anchor TEXT,
  page_type TEXT NOT NULL DEFAULT 'concept',
  display_order INTEGER NOT NULL DEFAULT 0,
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
  from_page_id INTEGER REFERENCES pages(id),
  to_page_id INTEGER REFERENCES pages(id),
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
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id)
);
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
);
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
CREATE INDEX IF NOT EXISTS idx_attempts_quiz_id ON quiz_attempts(quiz_id);
CREATE INDEX IF NOT EXISTS idx_pages_page_type ON pages(page_type);
CREATE INDEX IF NOT EXISTS idx_links_to_page ON links(to_page_id);
CREATE INDEX IF NOT EXISTS idx_links_from_page ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_page_id ON quizzes(page_id);
`;

export class Store {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
  }

  initSchema(): void {
    this.db.exec(SCHEMA);
    // Migrate: add explanation column if missing (for existing databases)
    try {
      this.db.exec("ALTER TABLE quizzes ADD COLUMN explanation TEXT DEFAULT ''");
    } catch {
      // Column already exists — ignore
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
        "INSERT OR REPLACE INTO pages (slug, title, content, source_id, section_anchor, page_type, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(slug, title, content, sourceId ?? null, sectionAnchor ?? null, pageType, displayOrder);
    return this.db.prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as Page;
  }

  getPage(slug: string): Page | null {
    return (this.db.prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as Page) ?? null;
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
    return this.db.prepare(`
      SELECT q.*, p.title as page_title, p.slug as page_slug,
        COALESCE(a.last_attempt, '1970-01-01') as last_attempt,
        COALESCE(a.correct_count, 0) as correct_count,
        COALESCE(a.wrong_count, 0) as wrong_count
      FROM quizzes q
      JOIN pages p ON p.id = q.page_id
      LEFT JOIN (
        SELECT quiz_id,
          MAX(attempted_at) as last_attempt,
          SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct_count,
          SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) as wrong_count
        FROM quiz_attempts
        GROUP BY quiz_id
      ) a ON a.quiz_id = q.id
      ORDER BY
        CASE WHEN a.last_attempt IS NULL THEN 0 ELSE 1 END,
        CASE WHEN a.wrong_count > 0 THEN 0 ELSE 1 END,
        a.last_attempt ASC
      LIMIT ?
    `).all(count) as Quiz[];
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

  addUsageLog(sourceId: number, calls: number, prompt: number, completion: number, total: number, cost: number): void {
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
}
