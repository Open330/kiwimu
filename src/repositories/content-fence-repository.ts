import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";

export interface FenceIdentity {
  /** Coordinator resource name, for example `content`. */
  resource: string;
  /** Opaque lease owner token returned by the coordinator. */
  ownerToken: string;
  /** Monotonic token issued for every successful coordinator acquisition. */
  fencingToken: number;
}

export interface ContentFence extends FenceIdentity {
  /** Monotonic epoch local to this content database and resource. */
  epoch: number;
}

interface ContentFenceRow {
  resource: string;
  epoch: number;
  owner_token: string;
  external_fencing_token: number;
}

/** Raised before a content mutation when its lease generation is no longer current. */
export class StaleContentFenceError extends Error {
  constructor(resource: string) {
    super(`Content fence for ${JSON.stringify(resource)} is stale or no longer owned`);
    this.name = "StaleContentFenceError";
  }
}

export interface ContentMutationRunner {
  run<T>(mutation: () => T): T;
}

export const directContentMutations: ContentMutationRunner = {
  run<T>(mutation: () => T): T {
    return mutation();
  },
};

/**
 * Bridges an external lease generation into the content database.
 *
 * The async context only carries identity. Every individual mutation obtains a
 * SQLite write reservation, validates that identity, and performs the write in
 * that same transaction. Long-running async work therefore never holds a DB
 * transaction open, while a stale worker cannot commit after a newer owner has
 * activated its fence.
 */
export class ContentFenceRepository implements ContentMutationRunner {
  private readonly context = new AsyncLocalStorage<ContentFence>();

  constructor(
    private readonly db: Database,
    private readonly beforeMutation?: () => void,
  ) {}

  activate(identity: FenceIdentity): ContentFence {
    validateIdentity(identity);

    const read = this.db.prepare(
      `SELECT resource, epoch, owner_token, external_fencing_token
       FROM content_fences WHERE resource = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO content_fences
         (resource, epoch, owner_token, external_fencing_token, updated_at)
       VALUES (?, 1, ?, ?, datetime('now'))`,
    );
    const advance = this.db.prepare(
      `UPDATE content_fences
       SET epoch = epoch + 1,
           owner_token = ?,
           external_fencing_token = ?,
           updated_at = datetime('now')
       WHERE resource = ?`,
    );

    const activate = this.db.transaction((): ContentFence => {
      const current = read.get(identity.resource) as ContentFenceRow | undefined;
      if (!current) {
        insert.run(identity.resource, identity.ownerToken, identity.fencingToken);
        return { ...identity, epoch: 1 };
      }

      if (identity.fencingToken < current.external_fencing_token) {
        throw new StaleContentFenceError(identity.resource);
      }
      if (identity.fencingToken === current.external_fencing_token) {
        if (identity.ownerToken !== current.owner_token) {
          throw new StaleContentFenceError(identity.resource);
        }
        return toContentFence(current);
      }

      advance.run(identity.ownerToken, identity.fencingToken, identity.resource);
      return {
        ...identity,
        epoch: current.epoch + 1,
      };
    });

    return activate.immediate();
  }

  getActive(resource: string): ContentFence | null {
    const row = this.db.prepare(
      `SELECT resource, epoch, owner_token, external_fencing_token
       FROM content_fences WHERE resource = ?`,
    ).get(resource) as ContentFenceRow | undefined;
    return row ? toContentFence(row) : null;
  }

  /** Fence propagated through the current async job, if one is active. */
  getCurrent(): ContentFence | null {
    return this.context.getStore() ?? null;
  }

  assertActive(fence: ContentFence): void {
    const row = this.db.prepare(
      `SELECT 1 FROM content_fences
       WHERE resource = ? AND epoch = ? AND owner_token = ?
         AND external_fencing_token = ?`,
    ).get(fence.resource, fence.epoch, fence.ownerToken, fence.fencingToken);
    if (!row) throw new StaleContentFenceError(fence.resource);
  }

  runWithFence<T>(fence: ContentFence, operation: () => T): T {
    this.assertActive(fence);
    return this.context.run(fence, operation);
  }

  /** Run one synchronous mutation, fencing it when a job context is active. */
  run<T>(mutation: () => T): T {
    // Owner-specific staging Stores use this hook to fail quickly after their
    // live generation loses ownership. Their distinct DB path provides the
    // cross-database isolation if ownership changes after this check.
    this.beforeMutation?.();
    const fence = this.context.getStore();
    if (!fence) return mutation();

    const fencedMutation = this.db.transaction((): T => {
      this.assertActive(fence);
      const result = mutation();
      if (isPromiseLike(result)) {
        throw new TypeError("Content mutations must be synchronous");
      }
      return result;
    });
    return fencedMutation.immediate();
  }
}

function toContentFence(row: ContentFenceRow): ContentFence {
  return {
    resource: row.resource,
    epoch: row.epoch,
    ownerToken: row.owner_token,
    fencingToken: row.external_fencing_token,
  };
}

function validateIdentity(identity: FenceIdentity): void {
  if (!identity.resource.trim()) throw new TypeError("Fence resource must not be empty");
  if (!identity.ownerToken.trim()) throw new TypeError("Fence owner token must not be empty");
  if (!Number.isSafeInteger(identity.fencingToken) || identity.fencingToken < 1) {
    throw new TypeError("Fence token must be a positive safe integer");
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}
