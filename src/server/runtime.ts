import { randomUUID } from "node:crypto";
import type { RuntimeCoordinator } from "../services/runtime-coordinator";
import type { LeaseAdmission, RuntimeLease } from "../services/runtime-state";
import {
  StaleContentFenceError,
  type ContentFence,
} from "../repositories/content-fence-repository";
import type { Store } from "../store";
import { apiJson } from "./http";

type RejectedLeaseAdmission = Extract<LeaseAdmission, { acquired: false }>;
type LeaseRuntime = Pick<RuntimeCoordinator, "isLeaseOwned" | "renewLease" | "releaseLease">;
type TaskRuntime = Pick<RuntimeCoordinator, "heartbeatTask">;
type TrackedTaskRuntime = TaskRuntime & Pick<
  RuntimeCoordinator,
  "createTask" | "completeTask" | "failTask"
>;
type ContentLeaseRuntime = LeaseRuntime & Pick<
  RuntimeCoordinator,
  "acquireLease" | "ensureLeaseFencingToken"
>;
type ContentFenceStore = Pick<Store, "activateContentFence" | "getActiveContentFence">;

export class LeaseOwnershipLostError extends Error {
  constructor(lease: RuntimeLease, reason: string, options: ErrorOptions = {}) {
    super(
      `Lease ownership lost for ${lease.resource}[${lease.slot}]; stale worker fenced (${reason})`,
      options,
    );
    this.name = "LeaseOwnershipLostError";
  }
}

export interface LeaseHeartbeat {
  readonly lost: boolean;
  renewNow(): Promise<boolean>;
  assertOwned(): Promise<void>;
  stop(): Promise<void>;
}

export interface AcquiredContentLease {
  acquired: true;
  retryAfterSeconds: 0;
  lease: RuntimeLease;
  heartbeat: LeaseHeartbeat;
  fence: ContentFence;
}

export type ContentLeaseAdmission = AcquiredContentLease | RejectedLeaseAdmission;

export interface DetachedContentJobHandle {
  /** Settles after the job error has been reported and its heartbeat stopped. */
  completion: Promise<void>;
}

export interface TrackedContentJobHandle extends DetachedContentJobHandle {
  taskId: string;
  /** Best-effort durable failure and heartbeat/lease release for forced shutdown. */
  interrupt(reason: string): Promise<void>;
}

export interface TrackedContentJobContext {
  /** Fails when either the durable content lease or task ownership was lost. */
  assertOwned(): Promise<void>;
  /** Aborted when forced-shutdown cleanup interrupts this tracked job. */
  signal: AbortSignal;
}

/**
 * Process-local admission and drain boundary for server work.
 *
 * Request admission is deliberately kept separate from `track`: an admitted
 * request may hand a detached completion promise to the tracker after shutdown
 * has begun, and that completion must still join the same drain.
 */
export class ServerTaskDrain {
  private accepting = true;
  private readonly active = new Map<Promise<void>, (() => void | Promise<void>) | undefined>();

  get isAccepting(): boolean {
    return this.accepting;
  }

  get activeCount(): number {
    return this.active.size;
  }

  beginDrain(): void {
    this.accepting = false;
  }

  track<T>(operation: Promise<T>, onTimeout?: () => void | Promise<void>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.active.set(settled, onTimeout);
    void settled.then(() => {
      this.active.delete(settled);
    });
    return operation;
  }

  async waitForDrain(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("shutdown drain timeout must be a non-negative integer");
    }
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      const snapshot = Promise.all([...this.active.keys()]);
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), remainingMs);
        void snapshot.then(() => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (timedOut) return false;
      // An admitted request can transfer ownership to a detached job as it
      // settles, so re-check the set instead of treating one snapshot as final.
    }
    return true;
  }

  async markTimedOut(cleanupTimeoutMs: number = 1_000): Promise<void> {
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 0) {
      throw new TypeError("shutdown timeout cleanup limit must be a non-negative integer");
    }
    const callbacks = [...this.active.values()].filter(
      (callback): callback is () => void | Promise<void> => callback !== undefined,
    );
    const cleanup = Promise.allSettled(callbacks.map((callback) => Promise.resolve().then(callback)));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, cleanupTimeoutMs);
      void cleanup.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export interface TrackedContentJobOptions<T> {
  runtimeState: TrackedTaskRuntime;
  store: Pick<Store, "runWithContentFence">;
  fence: ContentFence;
  contentHeartbeat: LeaseHeartbeat;
  taskKind: string;
  taskHeartbeatTtlMs: number;
  operation(context: TrackedContentJobContext): T | Promise<T>;
  reportError(error: unknown): void | Promise<void>;
  taskId?: string;
}

export class TaskOwnershipLostError extends Error {
  constructor(taskId: string, reason: string, options: ErrorOptions = {}) {
    super(`Task ownership lost for ${taskId}; stale worker stopped (${reason})`, options);
    this.name = "TaskOwnershipLostError";
  }
}

export function serverDrainingResponse(): Response {
  return apiJson(
    { error: "Server is shutting down; retry this operation on a ready instance" },
    { status: 503, headers: { "Retry-After": "1" } },
  );
}

export interface TaskHeartbeat {
  readonly lost: boolean;
  heartbeatNow(): Promise<boolean>;
  assertOwned(): Promise<void>;
  interrupt(reason: string): void;
  stop(): void;
}

export function conflictResponse(
  admission: RejectedLeaseAdmission,
  message: string = "이미 처리 중입니다",
): Response {
  return apiJson(
    {
      error: message,
      status: admission.status || "다른 콘텐츠 작업 처리 중",
      retry_after_seconds: admission.retryAfterSeconds,
    },
    {
      status: 409,
      headers: { "Retry-After": String(admission.retryAfterSeconds) },
    },
  );
}

export function uploadBusyResponse(admission: RejectedLeaseAdmission): Response {
  return apiJson(
    {
      error: "동시 업로드 처리 한도에 도달했습니다",
      status: admission.status || "다른 업로드 요청 수신 중",
      retry_after_seconds: admission.retryAfterSeconds,
    },
    {
      status: 429,
      headers: { "Retry-After": String(admission.retryAfterSeconds) },
    },
  );
}

export function keepLeaseAlive(
  runtimeState: LeaseRuntime,
  lease: RuntimeLease,
  ttlMs: number,
): LeaseHeartbeat {
  let loss: LeaseOwnershipLostError | null = null;
  let stopped = false;
  const markLost = (reason: string, cause?: unknown): void => {
    if (loss) return;
    loss = new LeaseOwnershipLostError(
      lease,
      reason,
      cause === undefined ? {} : { cause },
    );
    clearInterval(timer);
  };
  let renewal: Promise<boolean> | null = null;
  const renewNow = async (): Promise<boolean> => {
    if (stopped || loss) return false;
    if (renewal) return renewal;
    renewal = (async () => {
      try {
        const renewed = await runtimeState.renewLease(lease, ttlMs);
        if (!renewed) markLost("renewal rejected");
        return renewed;
      } catch (error) {
        markLost("renewal failed", error);
        return false;
      } finally {
        renewal = null;
      }
    })();
    return renewal;
  };
  const timer = setInterval(() => { void renewNow(); }, Math.max(1_000, Math.floor(ttlMs / 3)));
  timer.unref();
  let stopOperation: Promise<void> | null = null;
  return {
    get lost() {
      return loss !== null;
    },
    renewNow,
    async assertOwned(): Promise<void> {
      if (loss) throw loss;
      try {
        if (!await runtimeState.isLeaseOwned(lease)) {
          markLost("ownership check rejected");
        }
      } catch (error) {
        markLost("ownership check failed", error);
      }
      if (loss) throw loss;
    },
    stop(): Promise<void> {
      if (stopOperation) return stopOperation;
      stopped = true;
      clearInterval(timer);
      const inFlightRenewal = renewal;
      stopOperation = (async () => {
        // Once stopped is set no new renewal can start. Serialize the final
        // mutations so an already-dispatched renewal cannot follow release.
        await inFlightRenewal;
        try {
          await runtimeState.releaseLease(lease);
        } catch {
          // Expiry still releases the lease. Cleanup paths must not mask the
          // operation's original result when the coordinator is unavailable.
        }
      })();
      return stopOperation;
    },
  };
}

/**
 * Acquire a content lease and bridge its monotonic generation into kiwi.db.
 *
 * The coordinator is deliberately ephemeral, so it can be restored while the
 * content database still remembers a higher generation. A stale activation
 * fast-forwards the coordinator from the durable DB fence and retries once.
 */
export async function acquireContentLease(
  runtimeState: ContentLeaseRuntime,
  store: ContentFenceStore,
  resource: string,
  ttlMs: number,
  status: string,
): Promise<ContentLeaseAdmission> {
  const acquire = async (): Promise<ContentLeaseAdmission> => {
    const admission = await runtimeState.acquireLease(resource, ttlMs, 1, status);
    if (!admission.acquired) return admission;

    const heartbeat = keepLeaseAlive(runtimeState, admission.lease, ttlMs);
    try {
      return {
        ...admission,
        heartbeat,
        fence: store.activateContentFence(admission.lease),
      };
    } catch (error) {
      await heartbeat.stop();
      throw error;
    }
  };

  try {
    return await acquire();
  } catch (error) {
    if (!(error instanceof StaleContentFenceError)) throw error;
    const remembered = store.getActiveContentFence(resource);
    if (!remembered) throw error;
    await runtimeState.ensureLeaseFencingToken(resource, remembered.fencingToken);
    return acquire();
  }
}

/**
 * Start a fenced job without leaving a rejection or lease heartbeat orphaned.
 *
 * `runWithContentFence` validates the fence synchronously before invoking the
 * operation. A caller can therefore still return a controlled HTTP error when
 * this function rejects. Once the operation starts, its completion owns the
 * single heartbeat cleanup boundary and reports every async failure.
 */
export async function startDetachedContentJob(
  store: Pick<Store, "runWithContentFence">,
  fence: ContentFence,
  heartbeat: LeaseHeartbeat,
  operation: () => void | Promise<void>,
  reportError: (error: unknown) => void | Promise<void>,
): Promise<DetachedContentJobHandle> {
  let job: void | Promise<void>;
  try {
    job = store.runWithContentFence(fence, operation);
  } catch (error) {
    try {
      await heartbeat.stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Detached content job failed to start and release its lease");
    }
    throw error;
  }

  const completion = Promise.resolve(job)
    .catch(async (error) => {
      try {
        await reportError(error);
      } catch (reportingError) {
        console.error(
          `Detached content job error reporter failed: ${reportingError instanceof Error ? reportingError.message : String(reportingError)}`,
        );
      }
    })
    .finally(() => heartbeat.stop())
    .catch((cleanupError) => {
      console.error(
        `Detached content job lease cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    });

  return { completion };
}

/**
 * Start a detached content job with a durable, pollable terminal task state.
 *
 * The task heartbeat and content lease have one cleanup owner each. A failure
 * before detached-job ownership is established releases the content lease;
 * afterwards `startDetachedContentJob` owns that cleanup boundary.
 */
export async function startTrackedContentJob<T>(
  options: TrackedContentJobOptions<T>,
): Promise<TrackedContentJobHandle> {
  const {
    runtimeState,
    store,
    fence,
    contentHeartbeat,
    taskKind,
    taskHeartbeatTtlMs,
    operation,
    reportError,
  } = options;
  const taskId = options.taskId ?? randomUUID();
  let taskCreated = false;
  let taskHeartbeat: TaskHeartbeat | null = null;
  let failureRecorded = false;
  let interrupted = false;
  const operationController = new AbortController();

  const recordFailure = async (error: unknown): Promise<void> => {
    if (failureRecorded) return;
    failureRecorded = true;
    const message = error instanceof Error ? error.message : String(error);
    try {
      const failed = await runtimeState.failTask(taskId, message);
      if (!failed) {
        console.error(`Tracked task ${taskId} failure was rejected after ownership loss`);
      }
    } catch (statusError) {
      console.error(
        `Tracked task ${taskId} failure could not be stored: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
      );
    }
  };

  try {
    await contentHeartbeat.assertOwned();
    await runtimeState.createTask(taskId, taskKind, taskHeartbeatTtlMs);
    taskCreated = true;
    const ownedTaskHeartbeat = keepTaskAlive(runtimeState, taskId, taskHeartbeatTtlMs);
    taskHeartbeat = ownedTaskHeartbeat;

    const handle = await startDetachedContentJob(
      store,
      fence,
      contentHeartbeat,
      async () => {
        const assertOwned = async (): Promise<void> => {
          await ownedTaskHeartbeat.assertOwned();
          await contentHeartbeat.assertOwned();
        };
        try {
          await assertOwned();
          const result = await operation({ assertOwned, signal: operationController.signal });
          await assertOwned();
          const completed = await runtimeState.completeTask(
            taskId,
            result === undefined ? { ok: true } : result,
          );
          if (!completed) throw new TaskOwnershipLostError(taskId, "completion rejected");
        } catch (error) {
          await recordFailure(error);
          throw error;
        } finally {
          ownedTaskHeartbeat.stop();
        }
      },
      reportError,
    );

    // The detached operation now owns task-heartbeat cleanup.
    taskHeartbeat = null;
    return {
      taskId,
      completion: handle.completion,
      async interrupt(reason: string): Promise<void> {
        if (interrupted) return;
        interrupted = true;
        operationController.abort(new Error(reason));
        ownedTaskHeartbeat.interrupt(reason);
        await Promise.allSettled([
          recordFailure(new Error(reason)),
          contentHeartbeat.stop(),
        ]);
      },
    };
  } catch (error) {
    taskHeartbeat?.stop();
    if (taskCreated) {
      // A synchronous fence/start rejection never entered the operation body.
      await recordFailure(error);
    } else {
      // No detached cleanup boundary was established.
      await contentHeartbeat.stop();
    }
    throw error;
  }
}

export function keepTaskAlive(
  runtimeState: TaskRuntime,
  taskId: string,
  heartbeatTtlMs: number,
): TaskHeartbeat {
  let loss: TaskOwnershipLostError | null = null;
  let stopped = false;
  let heartbeat: Promise<boolean> | null = null;
  const markLost = (reason: string, cause?: unknown): void => {
    if (loss) return;
    loss = new TaskOwnershipLostError(
      taskId,
      reason,
      cause === undefined ? {} : { cause },
    );
    clearInterval(timer);
  };
  const heartbeatNow = async (): Promise<boolean> => {
    if (stopped || loss) return false;
    if (heartbeat) return heartbeat;
    heartbeat = (async () => {
      try {
        const owned = await runtimeState.heartbeatTask(taskId, heartbeatTtlMs);
        if (!owned) markLost("heartbeat rejected");
        return owned;
      } catch (error) {
        markLost("heartbeat failed", error);
        return false;
      } finally {
        heartbeat = null;
      }
    })();
    return heartbeat;
  };
  const timer = setInterval(
    () => { void heartbeatNow(); },
    Math.max(1_000, Math.floor(heartbeatTtlMs / 3)),
  );
  timer.unref();
  return {
    get lost() {
      return loss !== null;
    },
    heartbeatNow,
    async assertOwned(): Promise<void> {
      if (loss) throw loss;
      await heartbeatNow();
      if (loss) throw loss;
    },
    interrupt(reason: string): void {
      if (stopped || loss) return;
      markLost(reason);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
