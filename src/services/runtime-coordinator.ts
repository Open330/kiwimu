import { join } from "path";
import {
  RUNTIME_DB_FILE,
  RuntimeState,
  type LeaseAdmission,
  type RuntimeCleanupOptions,
  type RuntimeLease,
  type RuntimeRateLimitResult,
  type RuntimeTask,
} from "./runtime-state";
import {
  RedisRuntimeState,
  RuntimeCoordinatorUnavailableError,
} from "./redis-runtime-state";

export { RuntimeCoordinatorUnavailableError };

export type Awaitable<T> = T | Promise<T>;

/**
 * Runtime-only coordination shared by every server instance for one project.
 * Consumers must await every method: SQLite completes synchronously while the
 * external backend performs network I/O.
 */
export interface RuntimeCoordinator {
  close(): Awaitable<void>;
  consumeRateLimit(scope: string, key: string, limit: number, windowMs: number, now?: number): Awaitable<RuntimeRateLimitResult>;
  acquireLease(resource: string, ttlMs: number, capacity?: number, status?: string, now?: number): Awaitable<LeaseAdmission>;
  renewLease(lease: RuntimeLease, ttlMs: number, now?: number): Awaitable<boolean>;
  isLeaseOwned(lease: RuntimeLease, now?: number): Awaitable<boolean>;
  updateLeaseStatus(lease: RuntimeLease, status: string, ttlMs: number, now?: number): Awaitable<boolean>;
  releaseLease(lease: RuntimeLease): Awaitable<boolean>;
  getActiveLease(resource: string, now?: number): Awaitable<{ status: string; retryAfterSeconds: number } | null>;
  ensureLeaseFencingToken(resource: string, minimum: number): Awaitable<void>;
  createTask(id: string, kind: string, heartbeatTtlMs: number, now?: number): Awaitable<void>;
  heartbeatTask(id: string, heartbeatTtlMs: number, now?: number): Awaitable<boolean>;
  completeTask(id: string, result: unknown, now?: number): Awaitable<boolean>;
  failTask(id: string, error: string, now?: number): Awaitable<boolean>;
  getTask(id: string): Awaitable<RuntimeTask | null>;
  markAbandonedTasks(now?: number): Awaitable<number>;
  cleanup(options?: RuntimeCleanupOptions): Awaitable<void>;
}

export const COORDINATOR_URL_ENV = "KIWIMU_COORDINATOR_URL";
export const COORDINATOR_NAMESPACE_ENV = "KIWIMU_COORDINATOR_NAMESPACE";

export async function createRuntimeCoordinator(
  root: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<RuntimeCoordinator> {
  const url = environment[COORDINATOR_URL_ENV]?.trim();
  if (!url) return new RuntimeState(join(root, RUNTIME_DB_FILE));

  const namespace = environment[COORDINATOR_NAMESPACE_ENV]?.trim();
  if (!namespace) {
    throw new Error(`${COORDINATOR_NAMESPACE_ENV} is required when ${COORDINATOR_URL_ENV} is configured`);
  }

  const coordinator = new RedisRuntimeState(url, namespace);
  try {
    await coordinator.connect();
    return coordinator;
  } catch (error) {
    coordinator.close();
    throw new Error(
      `External runtime coordinator is unavailable (${COORDINATOR_URL_ENV}); refusing to start without cross-host coordination`,
      { cause: error },
    );
  }
}
