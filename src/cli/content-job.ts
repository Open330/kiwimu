import type { Store } from "../store";
import {
  createRuntimeCoordinator,
  type RuntimeCoordinator,
} from "../services/runtime-coordinator";
import { readBoundedInteger } from "../services/server-guards";
import {
  acquireContentLease,
  type LeaseHeartbeat,
} from "../server/runtime";

export const CONTENT_LEASE_RESOURCE = "content-mutation";

export interface CliContentJobContext {
  heartbeat: LeaseHeartbeat;
  /** Pass this to renderer publish hooks so an expired owner cannot replace output. */
  beforePublish(): Promise<void>;
}

export interface CliContentJobOptions {
  leaseTtlMs?: number;
  createCoordinator?: (root: string) => RuntimeCoordinator | Promise<RuntimeCoordinator>;
}

export class CliContentConflictError extends Error {
  constructor(status: string | undefined, retryAfterSeconds: number) {
    const activeStatus = status ? ` (${status})` : "";
    super(`다른 콘텐츠 작업이 진행 중입니다${activeStatus}. ${retryAfterSeconds}초 후 다시 시도해주세요.`);
    this.name = "CliContentConflictError";
  }
}

/**
 * Run one mutating CLI command under the same lease/fence contract as server jobs.
 *
 * The operation is not invoked unless both coordinator admission and durable DB
 * fence activation succeed. Every Store mutation in its async call tree then
 * validates that fence in the same SQLite transaction as the write.
 */
export async function runCliContentJob<T>(
  root: string,
  store: Store,
  status: string,
  operation: (context: CliContentJobContext) => T | Promise<T>,
  options: CliContentJobOptions = {},
): Promise<T> {
  const createCoordinator = options.createCoordinator ?? createRuntimeCoordinator;
  const runtimeState = await createCoordinator(root);
  const leaseTtlMs = options.leaseTtlMs ?? readBoundedInteger(
    process.env.KIWIMU_LEASE_TTL_SECONDS,
    300,
    30,
    3600,
  ) * 1000;
  let heartbeat: LeaseHeartbeat | null = null;

  try {
    const admission = await acquireContentLease(
      runtimeState,
      store,
      CONTENT_LEASE_RESOURCE,
      leaseTtlMs,
      status,
    );
    if (!admission.acquired) {
      throw new CliContentConflictError(admission.status, admission.retryAfterSeconds);
    }

    heartbeat = admission.heartbeat;
    const ownedHeartbeat = heartbeat;
    return await store.runWithContentFence(admission.fence, async () => {
      await ownedHeartbeat.assertOwned();
      const result = await operation({
        heartbeat: ownedHeartbeat,
        beforePublish: () => ownedHeartbeat.assertOwned(),
      });
      await ownedHeartbeat.assertOwned();
      return result;
    });
  } finally {
    await heartbeat?.stop();
    await runtimeState.close();
  }
}
