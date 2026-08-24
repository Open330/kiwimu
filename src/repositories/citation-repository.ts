import type { Database } from "bun:sqlite";
import type { Citation, SourceCoverage } from "./domain-types";
import {
  directContentMutations,
  type ContentMutationRunner,
} from "./content-fence-repository";

export interface CitationInput {
  sourceId: number;
  sourcePageId?: number;
  excerpt?: string;
  context?: string;
}

/** Citation persistence and provenance projections over Store's shared database. */
export class CitationRepository {
  constructor(
    private readonly db: Database,
    private readonly mutations: ContentMutationRunner = directContentMutations,
  ) {}

  addCitation(
    pageId: number,
    sourceId: number,
    sourcePageId?: number,
    excerpt?: string,
    context?: string,
  ): number {
    return this.mutations.run(() => {
      const result = this.db.prepare(
        "INSERT INTO citations (page_id, source_id, source_page_id, excerpt, context) VALUES (?, ?, ?, ?, ?)",
      ).run(pageId, sourceId, sourcePageId ?? null, excerpt ?? null, context ?? null);
      return Number(result.lastInsertRowid);
    });
  }

  /**
   * Atomically replace the complete citation set for one page.
   *
   * BEGIN IMMEDIATE acquires the SQLite write reservation before deleting, so
   * competing connections cannot interleave their delete/insert phases. A
   * failed insert rolls the deletion and every preceding insert back.
   */
  replaceCitations(pageId: number, citations: readonly CitationInput[]): number[] {
    const remove = this.db.prepare("DELETE FROM citations WHERE page_id = ?");
    const insert = this.db.prepare(
      "INSERT INTO citations (page_id, source_id, source_page_id, excerpt, context) VALUES (?, ?, ?, ?, ?)",
    );
    const replace = this.db.transaction((inputs: readonly CitationInput[]) => {
      remove.run(pageId);
      const ids: number[] = [];
      for (const citation of inputs) {
        const result = insert.run(
          pageId,
          citation.sourceId,
          citation.sourcePageId ?? null,
          citation.excerpt ?? null,
          citation.context ?? null,
        );
        ids.push(Number(result.lastInsertRowid));
      }
      return ids;
    });

    return this.mutations.run(() => replace.immediate(citations));
  }

  getCitationsForPage(pageId: number): Citation[] {
    return this.db.prepare(
      `SELECT c.*,
         s.title as source_title,
         sp.title as source_page_title,
         sp.slug as source_page_slug
       FROM citations c
       JOIN sources s ON s.id = c.source_id
       LEFT JOIN pages sp ON sp.id = c.source_page_id
       WHERE c.page_id = ?
       ORDER BY c.id`,
    ).all(pageId) as Citation[];
  }

  getCitationsForSource(sourceId: number): Citation[] {
    return this.db.prepare(
      `SELECT c.*,
         p.title as page_title,
         p.slug as page_slug,
         sp.title as source_page_title,
         sp.slug as source_page_slug
       FROM citations c
       JOIN pages p ON p.id = c.page_id
       LEFT JOIN pages sp ON sp.id = c.source_page_id
       WHERE c.source_id = ?
       ORDER BY c.id`,
    ).all(sourceId) as Citation[];
  }

  getSourceCoverage(): SourceCoverage[] {
    return this.db.prepare(
      `SELECT s.id as sourceId, s.title as sourceTitle,
         COUNT(c.id) as citationCount,
         COUNT(DISTINCT c.page_id) as pageCount
       FROM sources s
       LEFT JOIN citations c ON c.source_id = s.id
       GROUP BY s.id
       ORDER BY citationCount DESC`,
    ).all() as SourceCoverage[];
  }

  deleteCitationsForPage(pageId: number): void {
    this.mutations.run(() => {
      this.db.prepare("DELETE FROM citations WHERE page_id = ?").run(pageId);
    });
  }

  deleteCitationsBySource(sourceId: number): void {
    this.mutations.run(() => {
      this.db.prepare(
        "DELETE FROM citations WHERE page_id IN (SELECT id FROM pages WHERE source_id = ?) OR source_id = ?",
      ).run(sourceId, sourceId);
    });
  }

  deleteAllCitations(): void {
    this.mutations.run(() => {
      this.db.exec("DELETE FROM citations");
    });
  }
}
