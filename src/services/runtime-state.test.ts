import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { Database } from "bun:sqlite";
import { RuntimeState, SqliteDataVersion } from "./runtime-state";

describe("RuntimeState", () => {
  let directory: string;
  let dbPath: string;
  let states: RuntimeState[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "kiwimu-runtime-"));
    dbPath = join(directory, "runtime.db");
    states = [];
  });

  afterEach(() => {
    for (const state of states) state.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function open(instanceId: string): RuntimeState {
    const state = new RuntimeState(dbPath, instanceId);
    states.push(state);
    return state;
  }

  test("shares an atomic sliding-window rate limit across connections", () => {
    const first = open("process-a");
    const second = open("process-b");

    expect(first.consumeRateLimit("ask", "client", 2, 1_000, 0).allowed).toBe(true);
    expect(second.consumeRateLimit("ask", "client", 2, 1_000, 100).allowed).toBe(true);
    expect(first.consumeRateLimit("ask", "client", 2, 1_000, 200)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(second.consumeRateLimit("ask", "other-client", 2, 1_000, 200).allowed).toBe(true);
    expect(second.consumeRateLimit("ask", "client", 2, 1_000, 1_001).allowed).toBe(true);
  });

  test("tightens the runtime database and WAL sidecars to owner-only", () => {
    if (process.platform === "win32") return;
    const first = open("mode-first");
    chmodSync(dbPath, 0o644);
    first.close();
    states.splice(states.indexOf(first), 1);

    open("mode-reopened");
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      expect(statSync(`${dbPath}${suffix}`).mode & 0o777).toBe(0o600);
    }
  });

  test("bootstraps one empty runtime database across 40 concurrent processes", async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "runtime-state.ts")).href;
    const code = [
      `import { RuntimeState } from ${JSON.stringify(moduleUrl)};`,
      `const state = new RuntimeState(${JSON.stringify(dbPath)});`,
      `state.close();`,
    ].join("\n");
    const processes = Array.from(
      { length: 40 },
      () => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }),
    );
    const errorPromises = processes.map((process) => new Response(process.stderr).text());
    const exitCodes = await Promise.all(processes.map((process) => process.exited));
    const errors = await Promise.all(errorPromises);

    if (exitCodes.some((exitCode) => exitCode !== 0)) {
      throw new Error(`runtime bootstrap subprocess failed: ${errors.join("\n")}`);
    }
    expect(exitCodes).toEqual(Array.from({ length: 40 }, () => 0));
    const observer = open("observer");
    expect(observer.acquireLease("cold-start", 1_000, 1, "ready", 0).acquired).toBe(true);
  }, 15_000);

  test("allows exactly one cross-process lease owner and safely expires ownership", () => {
    const first = open("process-a");
    const second = open("process-b");
    const acquired = first.acquireLease("content", 1_000, 1, "빌드 중", 100);
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error("expected lease");
    expect(first.isLeaseOwned(acquired.lease, 100)).toBe(true);
    expect(second.isLeaseOwned(acquired.lease, 1_099)).toBe(true);
    expect(first.isLeaseOwned(acquired.lease, 1_100)).toBe(false);

    expect(second.acquireLease("content", 1_000, 1, "다른 작업", 101)).toEqual({
      acquired: false,
      retryAfterSeconds: 1,
      status: "빌드 중",
    });
    const replacement = second.acquireLease("content", 1_000, 1, "재시도", 1_100);
    expect(replacement.acquired).toBe(true);
    if (!replacement.acquired) throw new Error("expected replacement lease");

    expect(first.isLeaseOwned(acquired.lease, 1_100)).toBe(false);
    expect(second.isLeaseOwned(replacement.lease, 1_100)).toBe(true);

    expect(first.releaseLease(acquired.lease)).toBe(false);
    expect(second.releaseLease(replacement.lease)).toBe(true);
    expect(second.isLeaseOwned(replacement.lease, 1_101)).toBe(false);
  });

  test("never confuses a stale owner with a replacement in the same slot", () => {
    const staleWorker = open("stale-worker");
    const replacementWorker = open("replacement-worker");
    const staleAdmission = staleWorker.acquireLease("publish", 100, 1, "old", 1_000);
    expect(staleAdmission.acquired).toBe(true);
    if (!staleAdmission.acquired) throw new Error("expected stale lease");

    const replacementAdmission = replacementWorker.acquireLease("publish", 100, 1, "new", 1_100);
    expect(replacementAdmission.acquired).toBe(true);
    if (!replacementAdmission.acquired) throw new Error("expected replacement lease");

    expect(staleAdmission.lease.slot).toBe(replacementAdmission.lease.slot);
    expect(staleAdmission.lease.ownerToken).not.toBe(replacementAdmission.lease.ownerToken);
    expect(replacementAdmission.lease.fencingToken).toBe(staleAdmission.lease.fencingToken + 1);
    expect(staleWorker.isLeaseOwned(staleAdmission.lease, 1_100)).toBe(false);
    expect(staleWorker.renewLease(staleAdmission.lease, 100, 1_100)).toBe(false);
    expect(replacementWorker.isLeaseOwned(replacementAdmission.lease, 1_100)).toBe(true);
  });

  test("enforces bounded lease capacity before work is admitted", () => {
    const first = open("process-a");
    const second = open("process-b");
    const one = first.acquireLease("upload", 2_000, 2, "파싱 중", 0);
    const two = second.acquireLease("upload", 2_000, 2, "파싱 중", 0);
    const rejected = first.acquireLease("upload", 2_000, 2, "파싱 중", 0);

    expect(one.acquired).toBe(true);
    expect(two.acquired).toBe(true);
    expect(rejected).toEqual({ acquired: false, retryAfterSeconds: 2, status: "파싱 중" });
  });

  test("fast-forwards a restored lease epoch without ever moving it backwards", () => {
    const state = open("restored");
    state.ensureLeaseFencingToken("content", 41);
    state.ensureLeaseFencingToken("content", 7);
    const admission = state.acquireLease("content", 1_000, 1, "restored", 0);
    expect(admission.acquired).toBe(true);
    if (!admission.acquired) throw new Error("expected restored lease");
    expect(admission.lease.fencingToken).toBe(42);
  });

  test("persists task results and marks only expired workers as interrupted", () => {
    const worker = open("worker");
    const observer = open("observer");
    worker.createTask("live", "dynamic-qa", 100, 0);
    expect(observer.getTask("live")).toEqual({ status: "processing" });
    expect(observer.markAbandonedTasks(99)).toBe(0);
    expect(observer.markAbandonedTasks(100)).toBe(1);
    expect(observer.getTask("live")).toEqual({
      status: "error",
      error: "서버 작업이 중단되었습니다. 다시 시도해주세요.",
    });

    worker.createTask("done", "dynamic-qa", 100, 200);
    expect(worker.completeTask("done", { ok: true, slug: "result" }, 210)).toBe(true);
    expect(observer.getTask("done")).toEqual({
      status: "completed",
      result: { ok: true, slug: "result" },
    });
  });

  test("rejects task heartbeat and terminal transitions at or after heartbeat expiry", () => {
    const worker = open("worker");
    const create = (id: string): void => worker.createTask(id, "dynamic-qa", 100, 1_000);

    create("heartbeat-before");
    expect(worker.heartbeatTask("heartbeat-before", 100, 1_099)).toBe(true);
    create("heartbeat-exact");
    expect(worker.heartbeatTask("heartbeat-exact", 100, 1_100)).toBe(false);
    create("heartbeat-after");
    expect(worker.heartbeatTask("heartbeat-after", 100, 1_101)).toBe(false);

    create("complete-before");
    expect(worker.completeTask("complete-before", { ok: true }, 1_099)).toBe(true);
    create("complete-exact");
    expect(worker.completeTask("complete-exact", { ok: true }, 1_100)).toBe(false);
    create("complete-after");
    expect(worker.completeTask("complete-after", { ok: true }, 1_101)).toBe(false);

    create("fail-before");
    expect(worker.failTask("fail-before", "failed", 1_099)).toBe(true);
    create("fail-exact");
    expect(worker.failTask("fail-exact", "failed", 1_100)).toBe(false);
    create("fail-after");
    expect(worker.failTask("fail-after", "failed", 1_101)).toBe(false);
  });

  test("bounds finished task history by age and count", () => {
    const state = open("worker");
    for (let index = 0; index < 4; index++) {
      state.createTask(`task-${index}`, "test", 100, index * 10);
      state.completeTask(`task-${index}`, { index }, index * 10 + 1);
    }

    state.cleanup({
      now: 50,
      completedRetentionMs: 1_000,
      rateEventRetentionMs: 1_000,
      maxCompletedTasks: 2,
    });
    expect(state.getTask("task-0")).toBeNull();
    expect(state.getTask("task-1")).toBeNull();
    expect(state.getTask("task-2")?.status).toBe("completed");
    expect(state.getTask("task-3")?.status).toBe("completed");
  });
});

test("SqliteDataVersion observes commits from a separate content connection", () => {
  const directory = mkdtempSync(join(tmpdir(), "kiwimu-data-version-"));
  const dbPath = join(directory, "content.db");
  const writer = new Database(dbPath, { create: true });
  writer.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY, title TEXT)");
  const version = new SqliteDataVersion(dbPath);
  const initial = version.current();

  writer.run("INSERT INTO pages(title) VALUES (?)", ["new content"]);
  expect(version.current()).toBeGreaterThan(initial);

  version.close();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
});
