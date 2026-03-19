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
  quiz_type TEXT NOT NULL DEFAULT 'fill_blank',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id)
);
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
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
    // Delete quizzes for these pages first
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

  addQuiz(pageId: number, question: string, answer: string, quizType: string): void {
    this.db
      .prepare("INSERT INTO quizzes (page_id, question, answer, quiz_type) VALUES (?, ?, ?, ?)")
      .run(pageId, question, answer, quizType);
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
