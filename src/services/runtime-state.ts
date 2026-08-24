import crypto from "crypto";
import { Database } from "bun:sqlite";
import { hardenSqliteSidecars, preparePrivateSqliteFile } from "../sqlite-permissions";

/**
 * Runtime coordination intentionally lives beside, rather than inside, kiwi.db.
 * It is durable across processes sharing a project volume, but can be pruned or
 * recreated without changing user content or its backup/restore semantics.
 */
export const RUNTIME_DB_FILE = ".kiwimu-runtime.db";
const BOOTSTRAP_ATTEMPTS = 40;
const BOOTSTRAP_MAX_BACKOFF_MS = 50;

const RUNTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_rate_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_rate_events_lookup
  ON runtime_rate_events(scope, bucket_key, occurred_at_ms);

CREATE TABLE IF NOT EXISTS runtime_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'error')),
  result_json TEXT,
  error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  heartbeat_expires_at_ms INTEGER,
  finished_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS runtime_tasks_history
  ON runtime_tasks(status, finished_at_ms DESC);

CREATE TABLE IF NOT EXISTS runtime_leases (
  resource TEXT NOT NULL,
  slot INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(resource, slot)
);
CREATE INDEX IF NOT EXISTS runtime_leases_expiry
  ON runtime_leases(expires_at_ms);

CREATE TABLE IF NOT EXISTS runtime_lease_epochs (
  resource TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL CHECK(epoch > 0)
);
`;

export interface RuntimeRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RuntimeTask {
  status: "processing" | "completed" | "error";
  result?: unknown;
  error?: string;
}

export interface RuntimeLease {
  resource: string;
  slot: number;
  ownerToken: string;
  /** Monotonically increases for every successful acquisition of a resource. */
  fencingToken: number;
}

export type LeaseAdmission =
  | { acquired: true; lease: RuntimeLease; retryAfterSeconds: 0 }
  | { acquired: false; retryAfterSeconds: number; status?: string };

interface LeaseRow {
  resource: string;
  slot: number;
  owner_token: string;
  status: string;
  expires_at_ms: number;
}

interface TaskRow {
  status: RuntimeTask["status"];
  result_json: string | null;
  error: string | null;
}

export interface RuntimeCleanupOptions {
  now?: number;
  completedRetentionMs?: number;
  rateEventRetentionMs?: number;
  maxCompletedTasks?: number;
}

/**
 * Tracks commits made through other kiwi.db connections. SQLite data_version
 * is connection-local, so this dedicated reader complements Store's local
 * mutation revision without coupling cache state to runtime-state writes.
 */
export class SqliteDataVersion {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
    this.db.exec("PRAGMA busy_timeout = 30000");
  }

  current(): number {
    const row = this.db.query("PRAGMA data_version").get() as { data_version: number };
    return row.data_version;
  }

  close(): void {
    this.db.close();
  }
}

/** SQLite-backed state shared by every Kiwi Mu process using the same root. */
export class RuntimeState {
  private readonly db: Database;
  private readonly instanceId: string;

  constructor(dbPath: string, instanceId: string = crypto.randomUUID()) {
    preparePrivateSqliteFile(dbPath);
    this.db = new Database(dbPath, { create: true });
    this.instanceId = instanceId;
    try {
      this.bootstrap();
      hardenSqliteSidecars(dbPath);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private bootstrap(): void {
    this.db.exec("PRAGMA busy_timeout = 30000");
    for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
      try {
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA synchronous = NORMAL");
        this.db.exec(RUNTIME_SCHEMA);
        return;
      } catch (error) {
        if (!isSqliteBusyOrLocked(error) || attempt === BOOTSTRAP_ATTEMPTS - 1) throw error;
        synchronousBackoff(Math.min(BOOTSTRAP_MAX_BACKOFF_MS, 2 * (attempt + 1)));
      }
    }
  }

  /** Atomically consume one event from a cross-process sliding window. */
  consumeRateLimit(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
    now: number = Date.now(),
  ): RuntimeRateLimitResult {
    assertPositiveInteger(limit, "rate limit");
    assertPositiveInteger(windowMs, "rate window");
    const cutoff = now - windowMs;

    const transaction = this.db.transaction((): RuntimeRateLimitResult => {
      this.db.run(
        "DELETE FROM runtime_rate_events WHERE scope = ? AND bucket_key = ? AND occurred_at_ms <= ?",
        [scope, key, cutoff],
      );
      const countRow = this.db.query(
        "SELECT COUNT(*) AS count FROM runtime_rate_events WHERE scope = ? AND bucket_key = ?",
      ).get(scope, key) as { count: number };

      if (countRow.count < limit) {
        this.db.run(
          "INSERT INTO runtime_rate_events(scope, bucket_key, occurred_at_ms) VALUES (?, ?, ?)",
          [scope, key, now],
        );
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const oldest = this.db.query(
        "SELECT MIN(occurred_at_ms) AS occurred_at_ms FROM runtime_rate_events WHERE scope = ? AND bucket_key = ?",
      ).get(scope, key) as { occurred_at_ms: number };
      const waitMs = Math.max(1, windowMs - (now - oldest.occurred_at_ms));
      return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
    });

    return transaction.immediate();
  }

  /**
   * Acquire one of a bounded number of slots. BEGIN IMMEDIATE makes selecting
   * and inserting the slot atomic even when separate server processes race.
   */
  acquireLease(
    resource: string,
    ttlMs: number,
    capacity: number = 1,
    status: string = "",
    now: number = Date.now(),
  ): LeaseAdmission {
    assertPositiveInteger(ttlMs, "lease TTL");
    assertPositiveInteger(capacity, "lease capacity");
    const ownerToken = `${this.instanceId}:${crypto.randomUUID()}`;

    const transaction = this.db.transaction((): LeaseAdmission => {
      this.db.run(
        "DELETE FROM runtime_leases WHERE resource = ? AND expires_at_ms <= ?",
        [resource, now],
      );
      const rows = this.db.query(
        "SELECT resource, slot, owner_token, status, expires_at_ms FROM runtime_leases WHERE resource = ? ORDER BY slot",
      ).all(resource) as LeaseRow[];
      const occupied = new Set(rows.map(row => row.slot));
      let slot = -1;
      for (let candidate = 0; candidate < capacity; candidate++) {
        if (!occupied.has(candidate)) {
          slot = candidate;
          break;
        }
      }

      if (slot >= 0) {
        this.db.run(
          `INSERT INTO runtime_lease_epochs(resource, epoch) VALUES (?, 1)
           ON CONFLICT(resource) DO UPDATE SET epoch = epoch + 1`,
          [resource],
        );
        const epochRow = this.db.query(
          "SELECT epoch FROM runtime_lease_epochs WHERE resource = ?",
        ).get(resource) as { epoch: number };
        this.db.run(
          `INSERT INTO runtime_leases(resource, slot, owner_token, status, acquired_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [resource, slot, ownerToken, status, now, now + ttlMs],
        );
        return {
          acquired: true,
          lease: { resource, slot, ownerToken, fencingToken: epochRow.epoch },
          retryAfterSeconds: 0,
        };
      }

      const next = rows.reduce((minimum, row) => Math.min(minimum, row.expires_at_ms), Number.POSITIVE_INFINITY);
      const activeStatus = rows.find(row => row.status)?.status;
      return {
        acquired: false,
        retryAfterSeconds: Math.max(1, Math.ceil((next - now) / 1000)),
        ...(activeStatus ? { status: activeStatus } : {}),
      };
    });

    return transaction.immediate();
  }

  renewLease(lease: RuntimeLease, ttlMs: number, now: number = Date.now()): boolean {
    assertPositiveInteger(ttlMs, "lease TTL");
    const result = this.db.run(
      `UPDATE runtime_leases SET expires_at_ms = ?
       WHERE resource = ? AND slot = ? AND owner_token = ? AND expires_at_ms > ?`,
      [now + ttlMs, lease.resource, lease.slot, lease.ownerToken, now],
    );
    return result.changes === 1;
  }

  /**
   * Confirm that this exact owner still holds an unexpired lease slot.
   *
   * Checking only the resource is insufficient after expiry because another
   * process can acquire the same slot. The owner token fences the stale worker
   * from treating the replacement owner's lease as its own.
   */
  isLeaseOwned(lease: RuntimeLease, now: number = Date.now()): boolean {
    const row = this.db.query(
      `SELECT 1 as owned FROM runtime_leases
       WHERE resource = ? AND slot = ? AND owner_token = ? AND expires_at_ms > ?`,
    ).get(lease.resource, lease.slot, lease.ownerToken, now) as { owned: number } | null;
    return row?.owned === 1;
  }

  updateLeaseStatus(lease: RuntimeLease, status: string, ttlMs: number, now: number = Date.now()): boolean {
    assertPositiveInteger(ttlMs, "lease TTL");
    const result = this.db.run(
      `UPDATE runtime_leases SET status = ?, expires_at_ms = ?
       WHERE resource = ? AND slot = ? AND owner_token = ? AND expires_at_ms > ?`,
      [status, now + ttlMs, lease.resource, lease.slot, lease.ownerToken, now],
    );
    return result.changes === 1;
  }

  releaseLease(lease: RuntimeLease): boolean {
    const result = this.db.run(
      "DELETE FROM runtime_leases WHERE resource = ? AND slot = ? AND owner_token = ?",
      [lease.resource, lease.slot, lease.ownerToken],
    );
    return result.changes === 1;
  }

  getActiveLease(resource: string, now: number = Date.now()): { status: string; retryAfterSeconds: number } | null {
    const row = this.db.query(
      `SELECT status, expires_at_ms FROM runtime_leases
       WHERE resource = ? AND expires_at_ms > ? ORDER BY acquired_at_ms LIMIT 1`,
    ).get(resource, now) as { status: string; expires_at_ms: number } | null;
    if (!row) return null;
    return {
      status: row.status,
      retryAfterSeconds: Math.max(1, Math.ceil((row.expires_at_ms - now) / 1000)),
    };
  }

  /**
   * Recover availability after ephemeral coordinator state is restored while
   * the content database still remembers a higher fencing generation.
   */
  ensureLeaseFencingToken(resource: string, minimum: number): void {
    assertPositiveInteger(minimum, "minimum lease fencing token");
    const transaction = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO runtime_lease_epochs(resource, epoch) VALUES (?, ?)
         ON CONFLICT(resource) DO UPDATE SET epoch = MAX(epoch, excluded.epoch)`,
        [resource, minimum],
      );
    });
    transaction.immediate();
  }

  createTask(id: string, kind: string, heartbeatTtlMs: number, now: number = Date.now()): void {
    assertPositiveInteger(heartbeatTtlMs, "task heartbeat TTL");
    this.db.run(
      `INSERT INTO runtime_tasks(
         id, kind, owner_id, status, created_at_ms, updated_at_ms, heartbeat_expires_at_ms
       ) VALUES (?, ?, ?, 'processing', ?, ?, ?)`,
      [id, kind, this.instanceId, now, now, now + heartbeatTtlMs],
    );
  }

  heartbeatTask(id: string, heartbeatTtlMs: number, now: number = Date.now()): boolean {
    assertPositiveInteger(heartbeatTtlMs, "task heartbeat TTL");
    const result = this.db.run(
      `UPDATE runtime_tasks SET updated_at_ms = ?, heartbeat_expires_at_ms = ?
       WHERE id = ? AND owner_id = ? AND status = 'processing'
         AND heartbeat_expires_at_ms > ?`,
      [now, now + heartbeatTtlMs, id, this.instanceId, now],
    );
    return result.changes === 1;
  }

  completeTask(id: string, result: unknown, now: number = Date.now()): boolean {
    const resultJson = JSON.stringify(result);
    const change = this.db.run(
      `UPDATE runtime_tasks SET status = 'completed', result_json = ?, error = NULL,
         updated_at_ms = ?, heartbeat_expires_at_ms = NULL, finished_at_ms = ?
       WHERE id = ? AND owner_id = ? AND status = 'processing'
         AND heartbeat_expires_at_ms > ?`,
      [resultJson, now, now, id, this.instanceId, now],
    );
    return change.changes === 1;
  }

  failTask(id: string, error: string, now: number = Date.now()): boolean {
    const change = this.db.run(
      `UPDATE runtime_tasks SET status = 'error', result_json = NULL, error = ?,
         updated_at_ms = ?, heartbeat_expires_at_ms = NULL, finished_at_ms = ?
       WHERE id = ? AND owner_id = ? AND status = 'processing'
         AND heartbeat_expires_at_ms > ?`,
      [error, now, now, id, this.instanceId, now],
    );
    return change.changes === 1;
  }

  getTask(id: string): RuntimeTask | null {
    const row = this.db.query(
      "SELECT status, result_json, error FROM runtime_tasks WHERE id = ?",
    ).get(id) as TaskRow | null;
    if (!row) return null;
    if (row.status === "completed") {
      try {
        return { status: row.status, result: row.result_json === null ? null : JSON.parse(row.result_json) as unknown };
      } catch {
        return { status: "error", error: "저장된 작업 결과를 읽지 못했습니다" };
      }
    }
    if (row.status === "error") return { status: row.status, error: row.error ?? "작업이 실패했습니다" };
    return { status: row.status };
  }

  /** Mark only expired task owners as interrupted; live peer processes remain untouched. */
  markAbandonedTasks(now: number = Date.now()): number {
    const result = this.db.run(
      `UPDATE runtime_tasks SET status = 'error', error = ?, updated_at_ms = ?,
         heartbeat_expires_at_ms = NULL, finished_at_ms = ?
       WHERE status = 'processing' AND heartbeat_expires_at_ms <= ?`,
      ["서버 작업이 중단되었습니다. 다시 시도해주세요.", now, now, now],
    );
    return result.changes;
  }

  /** Age- and count-bound ephemeral history, old rate events, and expired leases. */
  cleanup(options: RuntimeCleanupOptions = {}): void {
    const now = options.now ?? Date.now();
    const completedRetentionMs = options.completedRetentionMs ?? 5 * 60 * 1000;
    const rateEventRetentionMs = options.rateEventRetentionMs ?? 60 * 60 * 1000;
    const maxCompletedTasks = options.maxCompletedTasks ?? 500;
    assertPositiveInteger(completedRetentionMs, "completed task retention");
    assertPositiveInteger(rateEventRetentionMs, "rate event retention");
    assertPositiveInteger(maxCompletedTasks, "completed task limit");

    const transaction = this.db.transaction(() => {
      this.markAbandonedTasks(now);
      this.db.run(
        "DELETE FROM runtime_tasks WHERE status != 'processing' AND finished_at_ms < ?",
        [now - completedRetentionMs],
      );
      this.db.run(
        `DELETE FROM runtime_tasks WHERE id IN (
           SELECT id FROM runtime_tasks WHERE status != 'processing'
           ORDER BY finished_at_ms DESC, id DESC LIMIT -1 OFFSET ?
         )`,
        [maxCompletedTasks],
      );
      this.db.run("DELETE FROM runtime_rate_events WHERE occurred_at_ms < ?", [now - rateEventRetentionMs]);
      this.db.run("DELETE FROM runtime_leases WHERE expires_at_ms <= ?", [now]);
    });
    transaction.immediate();
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function isSqliteBusyOrLocked(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ||
    /database (?:is )?(?:busy|locked)/i.test(error.message);
}

function synchronousBackoff(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}
