import type { Database } from "bun:sqlite";
import type {
  ActivityLogEntry,
  ActivityStats,
  UsageSummary,
} from "./domain-types";
import {
  directContentMutations,
  type ContentMutationRunner,
} from "./content-fence-repository";

interface CountRow {
  count: number;
}

interface ActionCountRow {
  action: string;
  count: number;
}

interface RecentDayRow {
  date: string;
  count: number;
}

/** Persistence for the append-only activity timeline and aggregate LLM usage. */
export class ActivityRepository {
  constructor(
    private readonly db: Database,
    private readonly mutations: ContentMutationRunner = directContentMutations,
  ) {}

  addActivityLog(
    action: string,
    title: string,
    entityType?: string,
    entityId?: number,
    details?: Record<string, unknown>,
  ): void {
    this.mutations.run(() => {
      this.db.prepare(
        "INSERT INTO activity_log (action, entity_type, entity_id, title, details) VALUES (?, ?, ?, ?, ?)",
      ).run(
        action,
        entityType ?? null,
        entityId ?? null,
        title,
        details ? JSON.stringify(details) : null,
      );
    });
  }

  getActivityLog(limit: number = 50, offset: number = 0, action?: string): ActivityLogEntry[] {
    if (action) {
      return this.db.prepare(
        "SELECT * FROM activity_log WHERE action = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      ).all(action, limit, offset) as ActivityLogEntry[];
    }
    return this.db.prepare(
      "SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    ).all(limit, offset) as ActivityLogEntry[];
  }

  getActivityStats(): ActivityStats {
    const total = (this.db.prepare(
      "SELECT COUNT(*) as count FROM activity_log",
    ).get() as CountRow).count;
    const byActionRows = this.db.prepare(
      "SELECT action, COUNT(*) as count FROM activity_log GROUP BY action",
    ).all() as ActionCountRow[];
    const byAction: Record<string, number> = {};
    for (const row of byActionRows) byAction[row.action] = row.count;

    const recentDays = this.db.prepare(
      "SELECT date(created_at) as date, COUNT(*) as count FROM activity_log WHERE created_at >= datetime('now', '-30 days') GROUP BY date(created_at) ORDER BY date DESC",
    ).all() as RecentDayRow[];
    return { total, byAction, recentDays };
  }

  addUsageLog(
    sourceId: number | null,
    calls: number,
    prompt: number,
    completion: number,
    total: number,
    cost: number,
  ): void {
    this.mutations.run(() => {
      this.db.prepare(
        "INSERT INTO usage_logs (source_id, llm_calls, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(sourceId, calls, prompt, completion, total, cost);
    });
  }

  getUsageSummary(): UsageSummary {
    return this.db.prepare(
      "SELECT COALESCE(SUM(llm_calls),0) as totalCalls, COALESCE(SUM(prompt_tokens),0) as promptTokens, COALESCE(SUM(completion_tokens),0) as completionTokens, COALESCE(SUM(total_tokens),0) as totalTokens, COALESCE(SUM(estimated_cost_usd),0) as totalCost FROM usage_logs",
    ).get() as UsageSummary;
  }
}
