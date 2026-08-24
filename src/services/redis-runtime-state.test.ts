import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaleContentFenceError } from "../repositories/content-fence-repository";
import { Store } from "../store";
import {
  RedisRuntimeState,
  RuntimeCoordinatorUnavailableError,
} from "./redis-runtime-state";

describe("RedisRuntimeState task command atomicity", () => {
  test("create, heartbeat, and finish obtain Redis time inside their mutation script", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const client = {
      async connect(): Promise<void> {},
      close(): void {},
      async send(command: string, args: string[]): Promise<unknown> {
        commands.push({ command, args });
        if (command === "EVAL") return 1;
        throw new Error(`Unexpected command: ${command}`);
      },
    };
    const state = new RedisRuntimeState("redis://127.0.0.1:6379", "task-atomicity", "worker", client);

    await state.createTask("task", "dynamic-qa", 1_000);
    expect(await state.heartbeatTask("task", 1_000, 10_500)).toBeTrue();
    expect(await state.completeTask("task", { answer: 42 })).toBeTrue();
    expect(await state.failTask("task", "failed", 10_600)).toBeTrue();

    expect(commands.map(({ command }) => command)).toEqual(["EVAL", "EVAL", "EVAL", "EVAL"]);
    for (const { args } of commands) {
      expect(args[0]).toContain("redis.call('TIME')");
    }

    // Three task keys precede the script arguments in every EVAL command.
    expect(commands[0]!.args.slice(5)).toEqual(["", "task", "dynamic-qa", "worker", "1000"]);
    expect(commands[1]!.args.slice(5)).toEqual(["10500", "task", "worker", "1000"]);
    expect(commands[2]!.args.slice(5)).toEqual(["", "task", "worker", "completed", '{"answer":42}']);
    expect(commands[3]!.args.slice(5)).toEqual(["10600", "task", "worker", "error", "failed"]);
  });

  test("does not replay a failed command and reconnects before the next command", async () => {
    const failedCommands: string[] = [];
    const failedClient = {
      async connect(): Promise<void> {},
      close(): void {},
      async send(command: string): Promise<unknown> {
        failedCommands.push(command);
        const error = new Error("Connection has failed") as Error & { code: string };
        error.code = "ERR_REDIS_CONNECTION_CLOSED";
        throw error;
      },
    };

    const recoveredCommands: string[] = [];
    let recoveredConnects = 0;
    const recoveredClient = {
      async connect(): Promise<void> { recoveredConnects++ },
      close(): void {},
      async send(command: string): Promise<unknown> {
        recoveredCommands.push(command);
        if (command === "PING") return "PONG";
        if (command === "EVAL") return [1, 0];
        throw new Error(`Unexpected command: ${command}`);
      },
    };

    const state = new RedisRuntimeState(
      "redis://127.0.0.1:6379",
      "reconnect",
      "worker",
      failedClient,
      () => recoveredClient,
    );

    await expect(state.consumeRateLimit("ask", "client", 1, 1_000))
      .rejects.toBeInstanceOf(RuntimeCoordinatorUnavailableError);
    expect(failedCommands).toEqual(["EVAL"]);

    expect(await state.consumeRateLimit("ask", "client", 1, 1_000)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(recoveredConnects).toBe(1);
    expect(recoveredCommands).toEqual(["PING", "EVAL"]);
    state.close();
  });

  test("bounds a never-settling established command without replaying it", async () => {
    const commands: string[] = [];
    let closes = 0;
    const client = {
      async connect(): Promise<void> {},
      close(): void { closes += 1; },
      send(command: string): Promise<unknown> {
        commands.push(command);
        return new Promise(() => {});
      },
    };
    const state = new RedisRuntimeState(
      "redis://127.0.0.1:6379",
      "command-deadline",
      "worker",
      client,
      undefined,
      10,
    );

    await expect(state.consumeRateLimit("ask", "client", 1, 1_000))
      .rejects.toBeInstanceOf(RuntimeCoordinatorUnavailableError);
    expect(commands).toEqual(["EVAL"]);
    expect(closes).toBe(1);
    state.close();
  });
});

const redisUrl = process.env.KIWIMU_TEST_REDIS_URL;
const integration = describe.skipIf(!redisUrl);

integration("RedisRuntimeState integration", () => {
  let first: RedisRuntimeState;
  let second: RedisRuntimeState;

  beforeEach(async () => {
    const namespace = `test-${crypto.randomUUID()}`;
    first = new RedisRuntimeState(redisUrl!, namespace, "first");
    second = new RedisRuntimeState(redisUrl!, namespace, "second");
    await Promise.all([first.connect(), second.connect()]);
  });

  afterEach(() => {
    first.close();
    second.close();
  });

  test("coordinates exclusive leases with monotonically increasing fencing tokens", async () => {
    await first.ensureLeaseFencingToken("content", 40);
    await first.ensureLeaseFencingToken("content", 7);
    const original = await first.acquireLease("content", 30_000, 1, "first job", 1_000);
    expect(original.acquired).toBe(true);
    if (!original.acquired) throw new Error("expected first lease");
    expect(original.lease.fencingToken).toBe(41);

    expect(await second.acquireLease("content", 30_000, 1, "second job", 1_001)).toEqual({
      acquired: false,
      retryAfterSeconds: 30,
      status: "first job",
    });

    const replacement = await second.acquireLease("content", 30_000, 1, "replacement", 31_000);
    expect(replacement.acquired).toBe(true);
    if (!replacement.acquired) throw new Error("expected replacement lease");
    expect(replacement.lease.fencingToken).toBe(original.lease.fencingToken + 1);
    expect(await first.renewLease(original.lease, 30_000, 31_000)).toBe(false);
    expect(await first.releaseLease(original.lease)).toBe(false);
    expect(await second.isLeaseOwned(replacement.lease, 31_001)).toBe(true);
  });

  test("shares capacity and sliding-window limits across clients", async () => {
    const one = await first.acquireLease("upload", 30_000, 2, "one", 0);
    const two = await second.acquireLease("upload", 30_000, 2, "two", 0);
    const rejected = await first.acquireLease("upload", 30_000, 2, "three", 0);
    expect(one.acquired).toBe(true);
    expect(two.acquired).toBe(true);
    expect(rejected.acquired).toBe(false);

    expect(await first.consumeRateLimit("ask", "client", 2, 60_000, 1_000)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect((await second.consumeRateLimit("ask", "client", 2, 60_000, 1_001)).allowed).toBe(true);
    expect(await first.consumeRateLimit("ask", "client", 2, 60_000, 1_002)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect((await second.consumeRateLimit("ask", "client", 2, 60_000, 61_001)).allowed).toBe(true);
  });

  test("persists task ownership, results, and abandoned-task cleanup across clients", async () => {
    await first.createTask("task-1", "dynamic-qa", 1_000, 10_000);
    expect(await second.getTask("task-1")).toEqual({ status: "processing" });
    expect(await second.heartbeatTask("task-1", 1_000, 10_500)).toBe(false);
    expect(await first.completeTask("task-1", { answer: 42 }, 10_600)).toBe(true);
    expect(await second.getTask("task-1")).toEqual({ status: "completed", result: { answer: 42 } });

    await first.createTask("task-2", "dynamic-qa", 100, 20_000);
    expect(await second.markAbandonedTasks(20_100)).toBe(1);
    expect(await first.getTask("task-2")).toEqual({
      status: "error",
      error: "서버 작업이 중단되었습니다. 다시 시도해주세요.",
    });

    await second.cleanup({ now: 30_000, completedRetentionMs: 1, maxCompletedTasks: 1 });
    expect(await first.getTask("task-1")).toBeNull();
    expect(await first.getTask("task-2")).toBeNull();
  });

  test("rejects task heartbeat and terminal transitions at or after heartbeat expiry", async () => {
    const create = (id: string): Promise<void> => first.createTask(id, "dynamic-qa", 100, 1_000);

    await create("heartbeat-before");
    expect(await first.heartbeatTask("heartbeat-before", 100, 1_099)).toBe(true);
    await create("heartbeat-exact");
    expect(await first.heartbeatTask("heartbeat-exact", 100, 1_100)).toBe(false);
    await create("heartbeat-after");
    expect(await first.heartbeatTask("heartbeat-after", 100, 1_101)).toBe(false);

    await create("complete-before");
    expect(await first.completeTask("complete-before", { ok: true }, 1_099)).toBe(true);
    await create("complete-exact");
    expect(await first.completeTask("complete-exact", { ok: true }, 1_100)).toBe(false);
    await create("complete-after");
    expect(await first.completeTask("complete-after", { ok: true }, 1_101)).toBe(false);

    await create("fail-before");
    expect(await first.failTask("fail-before", "failed", 1_099)).toBe(true);
    await create("fail-exact");
    expect(await first.failTask("fail-exact", "failed", 1_100)).toBe(false);
    await create("fail-after");
    expect(await first.failTask("fail-after", "failed", 1_101)).toBe(false);
  });

  test("fences a delayed content commit with a replacement Redis lease generation", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "kiwimu-redis-fence-"));
    const store = new Store(join(projectRoot, "kiwi.db"));
    try {
      store.addPage("target", "Target", "original");
      const staleAdmission = await first.acquireLease("content-mutation", 100, 1, "old", 1_000);
      expect(staleAdmission.acquired).toBe(true);
      if (!staleAdmission.acquired) throw new Error("expected stale lease");
      const staleFence = store.activateContentFence(staleAdmission.lease);

      let resumeStale!: () => void;
      const pauseStale = new Promise<void>(resolve => { resumeStale = resolve; });
      const staleJob = store.runWithContentFence(staleFence, async () => {
        await pauseStale;
        store.updatePageContentBySlug("target", "stale write");
      });

      const replacementAdmission = await second.acquireLease("content-mutation", 100, 1, "new", 1_100);
      expect(replacementAdmission.acquired).toBe(true);
      if (!replacementAdmission.acquired) throw new Error("expected replacement lease");
      const replacementFence = store.activateContentFence(replacementAdmission.lease);
      resumeStale();

      await expect(staleJob).rejects.toBeInstanceOf(StaleContentFenceError);
      expect(store.getPage("target")?.content).toBe("original");
      await store.runWithContentFence(replacementFence, async () => {
        store.updatePageContentBySlug("target", "replacement write");
      });
      expect(store.getPage("target")?.content).toBe("replacement write");
    } finally {
      store.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
