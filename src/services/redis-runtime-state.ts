import crypto from "crypto";
import { RedisClient } from "bun";
import type {
  LeaseAdmission,
  RuntimeCleanupOptions,
  RuntimeLease,
  RuntimeRateLimitResult,
  RuntimeTask,
} from "./runtime-state";

interface RedisCommandClient {
  connect(): Promise<void>;
  close(): void;
  send(command: string, args: string[]): Promise<unknown>;
}

export class RuntimeCoordinatorUnavailableError extends Error {
  constructor(options: ErrorOptions = {}) {
    super("Runtime coordinator is unavailable", options);
    this.name = "RuntimeCoordinatorUnavailableError";
  }
}

const ACQUIRE_LEASE_SCRIPT = String.raw`
local now_arg = ARGV[1]
local now
if now_arg ~= '' then
  now = tonumber(now_arg)
else
  local current = redis.call('TIME')
  now = tonumber(current[1]) * 1000 + math.floor(tonumber(current[2]) / 1000)
end
local ttl = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local owner = ARGV[4]
local status = ARGV[5]
local first_free = nil
local next_expiry = nil
local active_status = ''

for slot = 0, capacity - 1 do
  local raw = redis.call('HGET', KEYS[1], tostring(slot))
  if raw then
    local lease = cjson.decode(raw)
    if tonumber(lease.expires_at_ms) <= now then
      redis.call('HDEL', KEYS[1], tostring(slot))
      if first_free == nil then first_free = slot end
    else
      local expires = tonumber(lease.expires_at_ms)
      if next_expiry == nil or expires < next_expiry then next_expiry = expires end
      if active_status == '' and lease.status then active_status = lease.status end
    end
  elseif first_free == nil then
    first_free = slot
  end
end

if first_free ~= nil then
  local epoch = redis.call('INCR', KEYS[2])
  local lease = cjson.encode({
    owner_token = owner,
    status = status,
    acquired_at_ms = now,
    expires_at_ms = now + ttl,
    fencing_token = epoch
  })
  redis.call('HSET', KEYS[1], tostring(first_free), lease)
  local current_ttl = redis.call('PTTL', KEYS[1])
  if current_ttl < ttl then redis.call('PEXPIRE', KEYS[1], ttl) end
  return {1, first_free, epoch}
end

local retry = math.max(1, math.ceil((next_expiry - now) / 1000))
return {0, retry, active_status}
`;

const OWN_LEASE_SCRIPT = String.raw`
local now_arg = ARGV[1]
local now
if now_arg ~= '' then now = tonumber(now_arg) else
  local current = redis.call('TIME')
  now = tonumber(current[1]) * 1000 + math.floor(tonumber(current[2]) / 1000)
end
local raw = redis.call('HGET', KEYS[1], ARGV[2])
if not raw then return 0 end
local lease = cjson.decode(raw)
if lease.owner_token ~= ARGV[3] or tonumber(lease.fencing_token) ~= tonumber(ARGV[4]) then return 0 end
if tonumber(lease.expires_at_ms) <= now then
  redis.call('HDEL', KEYS[1], ARGV[2])
  return 0
end
return 1
`;

const RENEW_LEASE_SCRIPT = String.raw`
local now_arg = ARGV[1]
local now
if now_arg ~= '' then now = tonumber(now_arg) else
  local current = redis.call('TIME')
  now = tonumber(current[1]) * 1000 + math.floor(tonumber(current[2]) / 1000)
end
local ttl = tonumber(ARGV[2])
local raw = redis.call('HGET', KEYS[1], ARGV[3])
if not raw then return 0 end
local lease = cjson.decode(raw)
if lease.owner_token ~= ARGV[4] or tonumber(lease.fencing_token) ~= tonumber(ARGV[5]) or tonumber(lease.expires_at_ms) <= now then return 0 end
lease.expires_at_ms = now + ttl
redis.call('HSET', KEYS[1], ARGV[3], cjson.encode(lease))
local current_ttl = redis.call('PTTL', KEYS[1])
if current_ttl < ttl then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
`;

const UPDATE_LEASE_SCRIPT = String.raw`
local now_arg = ARGV[1]
local now
if now_arg ~= '' then now = tonumber(now_arg) else
  local current = redis.call('TIME')
  now = tonumber(current[1]) * 1000 + math.floor(tonumber(current[2]) / 1000)
end
local ttl = tonumber(ARGV[2])
local raw = redis.call('HGET', KEYS[1], ARGV[3])
if not raw then return 0 end
local lease = cjson.decode(raw)
if lease.owner_token ~= ARGV[4] or tonumber(lease.fencing_token) ~= tonumber(ARGV[5]) or tonumber(lease.expires_at_ms) <= now then return 0 end
lease.status = ARGV[6]
lease.expires_at_ms = now + ttl
redis.call('HSET', KEYS[1], ARGV[3], cjson.encode(lease))
local current_ttl = redis.call('PTTL', KEYS[1])
if current_ttl < ttl then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
`;

const RELEASE_LEASE_SCRIPT = String.raw`
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local lease = cjson.decode(raw)
if lease.owner_token ~= ARGV[2] or tonumber(lease.fencing_token) ~= tonumber(ARGV[3]) then return 0 end
return redis.call('HDEL', KEYS[1], ARGV[1])
`;

const ACTIVE_LEASE_SCRIPT = String.raw`
local now_arg = ARGV[1]
local now
if now_arg ~= '' then now = tonumber(now_arg) else
  local current = redis.call('TIME')
  now = tonumber(current[1]) * 1000 + math.floor(tonumber(current[2]) / 1000)
end
local rows = redis.call('HGETALL', KEYS[1])
local selected = nil
for index = 1, #rows, 2 do
  local lease = cjson.decode(rows[index + 1])
  if tonumber(lease.expires_at_ms) <= now then
    redis.call('HDEL', KEYS[1], rows[index])
  elseif selected == nil or tonumber(lease.acquired_at_ms) < tonumber(selected.acquired_at_ms) then
    selected = lease
  end
end
if selected == nil then return {} end
return {selected.status or '', math.max(1, math.ceil((tonumber(selected.expires_at_ms) - now) / 1000))}
`;

const RATE_LIMIT_SCRIPT = String.raw`
local now_arg = ARGV[1]
local now
if now_arg ~= '' then now = tonumber(now_arg) else
  local current = redis.call('TIME')
  now = tonumber(current[1]) * 1000 + math.floor(tonumber(current[2]) / 1000)
end
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = math.max(1, math.ceil((window - (now - tonumber(oldest[2]))) / 1000))
return {0, retry}
`;

const ENSURE_FENCING_TOKEN_SCRIPT = String.raw`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local minimum = tonumber(ARGV[1])
if current < minimum then redis.call('SET', KEYS[1], minimum) end
return 1
`;

const TASK_TIME_SCRIPT = String.raw`
local now_arg = ARGV[1]
local now
if now_arg ~= '' then
  now = tonumber(now_arg)
else
  local current = redis.call('TIME')
  now = tonumber(current[1]) * 1000 + math.floor(tonumber(current[2]) / 1000)
end
`;

const CREATE_TASK_SCRIPT = String.raw`
${TASK_TIME_SCRIPT}
local id = ARGV[2]
if redis.call('HEXISTS', KEYS[1], id) == 1 then return 0 end
local heartbeat_expires_at = now + tonumber(ARGV[5])
local task = cjson.encode({
  kind = ARGV[3],
  owner_id = ARGV[4],
  status = 'processing',
  result_json = cjson.null,
  error = cjson.null,
  created_at_ms = now,
  updated_at_ms = now,
  heartbeat_expires_at_ms = heartbeat_expires_at,
  finished_at_ms = cjson.null
})
redis.call('HSET', KEYS[1], id, task)
redis.call('ZADD', KEYS[2], heartbeat_expires_at, id)
return 1
`;

const UPDATE_TASK_HEARTBEAT_SCRIPT = String.raw`
${TASK_TIME_SCRIPT}
local id = ARGV[2]
local raw = redis.call('HGET', KEYS[1], id)
if not raw then return 0 end
local task = cjson.decode(raw)
if task.owner_id ~= ARGV[3] or task.status ~= 'processing' then return 0 end
if task.heartbeat_expires_at_ms == nil or task.heartbeat_expires_at_ms == cjson.null then return 0 end
if tonumber(task.heartbeat_expires_at_ms) <= now then return 0 end
local heartbeat_expires_at = now + tonumber(ARGV[4])
task.updated_at_ms = now
task.heartbeat_expires_at_ms = heartbeat_expires_at
redis.call('HSET', KEYS[1], id, cjson.encode(task))
redis.call('ZADD', KEYS[2], heartbeat_expires_at, id)
return 1
`;

const FINISH_TASK_SCRIPT = String.raw`
${TASK_TIME_SCRIPT}
local id = ARGV[2]
local raw = redis.call('HGET', KEYS[1], id)
if not raw then return 0 end
local task = cjson.decode(raw)
if task.owner_id ~= ARGV[3] or task.status ~= 'processing' then return 0 end
if task.heartbeat_expires_at_ms == nil or task.heartbeat_expires_at_ms == cjson.null then return 0 end
if tonumber(task.heartbeat_expires_at_ms) <= now then return 0 end
task.status = ARGV[4]
task.updated_at_ms = now
task.finished_at_ms = now
task.heartbeat_expires_at_ms = cjson.null
if ARGV[4] == 'completed' then
  task.result_json = ARGV[5]
  task.error = cjson.null
else
  task.result_json = cjson.null
  task.error = ARGV[5]
end
redis.call('HSET', KEYS[1], id, cjson.encode(task))
redis.call('ZREM', KEYS[2], id)
redis.call('ZADD', KEYS[3], now, id)
return 1
`;

const ABANDON_TASKS_SCRIPT = String.raw`
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 1000)
local changed = 0
for _, id in ipairs(expired) do
  local raw = redis.call('HGET', KEYS[1], id)
  if raw then
    local task = cjson.decode(raw)
    if task.status == 'processing' and tonumber(task.heartbeat_expires_at_ms) <= tonumber(ARGV[1]) then
      task.status = 'error'
      task.error = ARGV[2]
      task.result_json = cjson.null
      task.updated_at_ms = tonumber(ARGV[1])
      task.finished_at_ms = tonumber(ARGV[1])
      task.heartbeat_expires_at_ms = cjson.null
      redis.call('HSET', KEYS[1], id, cjson.encode(task))
      redis.call('ZADD', KEYS[3], ARGV[1], id)
      changed = changed + 1
    end
  end
  redis.call('ZREM', KEYS[2], id)
end
return changed
`;

const CLEANUP_TASKS_SCRIPT = String.raw`
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 1000)
for _, id in ipairs(expired) do
  local raw = redis.call('HGET', KEYS[1], id)
  if raw then
    local task = cjson.decode(raw)
    if task.status == 'processing' and tonumber(task.heartbeat_expires_at_ms) <= tonumber(ARGV[1]) then
      task.status = 'error'
      task.error = ARGV[4]
      task.result_json = cjson.null
      task.updated_at_ms = tonumber(ARGV[1])
      task.finished_at_ms = tonumber(ARGV[1])
      task.heartbeat_expires_at_ms = cjson.null
      redis.call('HSET', KEYS[1], id, cjson.encode(task))
      redis.call('ZADD', KEYS[3], ARGV[1], id)
    end
  end
  redis.call('ZREM', KEYS[2], id)
end

local old = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]), 'LIMIT', 0, 1000)
for _, id in ipairs(old) do
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[3], id)
end

local excess = redis.call('ZCARD', KEYS[3]) - tonumber(ARGV[3])
if excess > 0 then
  local overflow = redis.call('ZRANGE', KEYS[3], 0, math.min(excess - 1, 999))
  for _, id in ipairs(overflow) do
    redis.call('HDEL', KEYS[1], id)
    redis.call('ZREM', KEYS[3], id)
  end
end
return 1
`;

const TASK_INTERRUPTED_MESSAGE = "서버 작업이 중단되었습니다. 다시 시도해주세요.";
const REDIS_OPERATION_DEADLINE_MS = 5_000;

/** Redis/Valkey-backed runtime coordination for hosts without a shared volume. */
export class RedisRuntimeState {
  private client: RedisCommandClient | null;
  private connecting: Promise<RedisCommandClient> | null = null;
  private closed = false;
  private readonly createClient: () => RedisCommandClient;
  private readonly commandDeadlineMs: number;
  private readonly instanceId: string;
  private readonly prefix: string;

  constructor(
    url: string,
    namespace: string,
    instanceId: string = crypto.randomUUID(),
    client?: RedisCommandClient,
    clientFactory?: () => RedisCommandClient,
    commandDeadlineMs: number = REDIS_OPERATION_DEADLINE_MS,
  ) {
    validateCoordinatorUrl(url);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(namespace)) {
      throw new Error("KIWIMU_COORDINATOR_NAMESPACE must contain 1-64 letters, numbers, dots, underscores, or hyphens");
    }
    assertPositiveInteger(commandDeadlineMs, "Redis command deadline");
    this.commandDeadlineMs = commandDeadlineMs;
    this.createClient = clientFactory ?? (() => new RedisClient(url, {
        connectionTimeout: REDIS_OPERATION_DEADLINE_MS,
        // A server may legitimately be quiet for hours. Keep the connection
        // alive; coordinator commands must not fail merely because no request
        // arrived during a client-side idle window.
        idleTimeout: 0,
        // Recreate the client on the next command instead of letting the Redis
        // library queue or replay a mutation whose commit outcome is unknown.
        autoReconnect: false,
        enableOfflineQueue: false,
      }));
    // Injected clients are considered ready so narrow command-atomicity tests
    // do not need to emulate a Redis connection handshake.
    this.client = client ?? null;
    this.instanceId = instanceId;
    // The hash tag keeps every project key in one Redis Cluster slot so Lua
    // scripts can update related keys atomically.
    this.prefix = `kiwimu:{${namespace}}`;
  }

  async connect(): Promise<void> {
    await this.connectedClient();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const client = this.client;
    this.client = null;
    try {
      client?.close();
    } catch {
      // Shutdown must continue even if the failed socket is already closed.
    }
  }

  async consumeRateLimit(scope: string, key: string, limit: number, windowMs: number, now?: number): Promise<RuntimeRateLimitResult> {
    assertPositiveInteger(limit, "rate limit");
    assertPositiveInteger(windowMs, "rate window");
    const result = asArray(await this.eval(
      RATE_LIMIT_SCRIPT,
      [this.key("rate", scope, key)],
      [optionalNow(now), String(limit), String(windowMs), `${this.instanceId}:${crypto.randomUUID()}`],
    ));
    return { allowed: asNumber(result[0]) === 1, retryAfterSeconds: asNumber(result[1]) };
  }

  async acquireLease(resource: string, ttlMs: number, capacity: number = 1, status: string = "", now?: number): Promise<LeaseAdmission> {
    assertPositiveInteger(ttlMs, "lease TTL");
    assertPositiveInteger(capacity, "lease capacity");
    const ownerToken = `${this.instanceId}:${crypto.randomUUID()}`;
    const result = asArray(await this.eval(
      ACQUIRE_LEASE_SCRIPT,
      [this.key("leases", resource), this.key("lease-epoch", resource)],
      [optionalNow(now), String(ttlMs), String(capacity), ownerToken, status],
    ));
    if (asNumber(result[0]) === 1) {
      return {
        acquired: true,
        lease: {
          resource,
          slot: asNumber(result[1]),
          ownerToken,
          fencingToken: asSafeInteger(result[2], "lease fencing token"),
        },
        retryAfterSeconds: 0,
      };
    }
    const activeStatus = String(result[2] ?? "");
    return {
      acquired: false,
      retryAfterSeconds: asNumber(result[1]),
      ...(activeStatus ? { status: activeStatus } : {}),
    };
  }

  async renewLease(lease: RuntimeLease, ttlMs: number, now?: number): Promise<boolean> {
    assertPositiveInteger(ttlMs, "lease TTL");
    return asNumber(await this.eval(RENEW_LEASE_SCRIPT, [this.key("leases", lease.resource)], [
      optionalNow(now), String(ttlMs), String(lease.slot), lease.ownerToken, String(lease.fencingToken),
    ])) === 1;
  }

  async isLeaseOwned(lease: RuntimeLease, now?: number): Promise<boolean> {
    return asNumber(await this.eval(OWN_LEASE_SCRIPT, [this.key("leases", lease.resource)], [
      optionalNow(now), String(lease.slot), lease.ownerToken, String(lease.fencingToken),
    ])) === 1;
  }

  async updateLeaseStatus(lease: RuntimeLease, status: string, ttlMs: number, now?: number): Promise<boolean> {
    assertPositiveInteger(ttlMs, "lease TTL");
    return asNumber(await this.eval(UPDATE_LEASE_SCRIPT, [this.key("leases", lease.resource)], [
      optionalNow(now), String(ttlMs), String(lease.slot), lease.ownerToken, String(lease.fencingToken), status,
    ])) === 1;
  }

  async releaseLease(lease: RuntimeLease): Promise<boolean> {
    return asNumber(await this.eval(RELEASE_LEASE_SCRIPT, [this.key("leases", lease.resource)], [
      String(lease.slot), lease.ownerToken, String(lease.fencingToken),
    ])) === 1;
  }

  async getActiveLease(resource: string, now?: number): Promise<{ status: string; retryAfterSeconds: number } | null> {
    const result = asArray(await this.eval(ACTIVE_LEASE_SCRIPT, [this.key("leases", resource)], [optionalNow(now)]));
    if (result.length === 0) return null;
    return { status: String(result[0] ?? ""), retryAfterSeconds: asNumber(result[1]) };
  }

  async ensureLeaseFencingToken(resource: string, minimum: number): Promise<void> {
    assertPositiveInteger(minimum, "minimum lease fencing token");
    await this.eval(ENSURE_FENCING_TOKEN_SCRIPT, [this.key("lease-epoch", resource)], [String(minimum)]);
  }

  async createTask(id: string, kind: string, heartbeatTtlMs: number, now?: number): Promise<void> {
    assertPositiveInteger(heartbeatTtlMs, "task heartbeat TTL");
    const created = asNumber(await this.eval(CREATE_TASK_SCRIPT, this.taskKeys(), [
      optionalNow(now), id, kind, this.instanceId, String(heartbeatTtlMs),
    ]));
    if (created !== 1) throw new Error(`Runtime task already exists: ${id}`);
  }

  async heartbeatTask(id: string, heartbeatTtlMs: number, now?: number): Promise<boolean> {
    assertPositiveInteger(heartbeatTtlMs, "task heartbeat TTL");
    return asNumber(await this.eval(UPDATE_TASK_HEARTBEAT_SCRIPT, this.taskKeys(), [
      optionalNow(now), id, this.instanceId, String(heartbeatTtlMs),
    ])) === 1;
  }

  async completeTask(id: string, result: unknown, now?: number): Promise<boolean> {
    const resultJson = JSON.stringify(result);
    return asNumber(await this.eval(FINISH_TASK_SCRIPT, this.taskKeys(), [
      optionalNow(now), id, this.instanceId, "completed", resultJson,
    ])) === 1;
  }

  async failTask(id: string, error: string, now?: number): Promise<boolean> {
    return asNumber(await this.eval(FINISH_TASK_SCRIPT, this.taskKeys(), [
      optionalNow(now), id, this.instanceId, "error", error,
    ])) === 1;
  }

  async getTask(id: string): Promise<RuntimeTask | null> {
    const raw = await this.send("HGET", [this.taskKeys()[0]!, id]);
    if (raw === null) return null;
    try {
      const row = JSON.parse(String(raw)) as {
        status?: unknown;
        result_json?: unknown;
        error?: unknown;
      };
      if (row.status === "completed") {
        const result = typeof row.result_json === "string" ? JSON.parse(row.result_json) as unknown : null;
        return { status: row.status, result };
      }
      if (row.status === "error") {
        return { status: row.status, error: typeof row.error === "string" ? row.error : "작업이 실패했습니다" };
      }
      if (row.status === "processing") return { status: row.status };
      return { status: "error", error: "저장된 작업 상태를 읽지 못했습니다" };
    } catch {
      return { status: "error", error: "저장된 작업 결과를 읽지 못했습니다" };
    }
  }

  async markAbandonedTasks(now?: number): Promise<number> {
    const currentTime = await this.currentTime(now);
    return asNumber(await this.eval(ABANDON_TASKS_SCRIPT, this.taskKeys(), [
      String(currentTime), TASK_INTERRUPTED_MESSAGE,
    ]));
  }

  async cleanup(options: RuntimeCleanupOptions = {}): Promise<void> {
    const now = await this.currentTime(options.now);
    const completedRetentionMs = options.completedRetentionMs ?? 5 * 60 * 1000;
    const maxCompletedTasks = options.maxCompletedTasks ?? 500;
    assertPositiveInteger(completedRetentionMs, "completed task retention");
    assertPositiveInteger(options.rateEventRetentionMs ?? 60 * 60 * 1000, "rate event retention");
    assertPositiveInteger(maxCompletedTasks, "completed task limit");
    await this.eval(CLEANUP_TASKS_SCRIPT, this.taskKeys(), [
      String(now), String(completedRetentionMs), String(maxCompletedTasks), TASK_INTERRUPTED_MESSAGE,
    ]);
  }

  private taskKeys(): [string, string, string] {
    return [this.key("tasks"), this.key("task-heartbeats"), this.key("task-history")];
  }

  private key(...segments: string[]): string {
    return `${this.prefix}:${segments.map(encodeKeyPart).join(":")}`;
  }

  private eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.send("EVAL", [script, String(keys.length), ...keys, ...args]);
  }

  private async currentTime(override: number | undefined): Promise<number> {
    if (override !== undefined) {
      optionalNow(override);
      return override;
    }
    const response = asArray(await this.send("TIME", []));
    const seconds = asNumber(response[0]);
    const microseconds = asNumber(response[1]);
    const milliseconds = seconds * 1000 + Math.floor(microseconds / 1000);
    if (!Number.isSafeInteger(milliseconds)) throw new Error("Invalid coordinator time response");
    return milliseconds;
  }

  /**
   * Return a connected client, creating a fresh socket after a prior transport
   * failure. The command which observed the failure is never replayed because
   * a mutation may already have committed before the connection was lost.
   */
  private async connectedClient(): Promise<RedisCommandClient> {
    if (this.closed) throw new RuntimeCoordinatorUnavailableError();
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    const connecting = (async () => {
      const candidate = this.createClient();
      try {
        const response = await withDeadline((async () => {
          await candidate.connect();
          return candidate.send("PING", []);
        })(), REDIS_OPERATION_DEADLINE_MS, "Coordinator connection deadline exceeded");
        if (String(response).toUpperCase() !== "PONG") {
          throw new Error("Coordinator PING failed");
        }
        if (this.closed) throw new RuntimeCoordinatorUnavailableError();
        this.client = candidate;
        return candidate;
      } catch (error) {
        try {
          candidate.close();
        } catch {
          // Preserve the connection failure as the actionable error.
        }
        if (error instanceof RuntimeCoordinatorUnavailableError) throw error;
        throw new RuntimeCoordinatorUnavailableError({ cause: error });
      }
    })();
    this.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  private async send(command: string, args: string[]): Promise<unknown> {
    const client = await this.connectedClient();
    try {
      return await withDeadline(
        client.send(command, args),
        this.commandDeadlineMs,
        "Coordinator command deadline exceeded",
      );
    } catch (error) {
      if (!(error instanceof CoordinatorDeadlineError) && !isRedisConnectionFailure(error)) throw error;
      if (this.client === client) {
        this.client = null;
        try {
          client.close();
        } catch {
          // The transport is already failed; the next command will reconnect.
        }
      }
      throw new RuntimeCoordinatorUnavailableError({ cause: error });
    }
  }
}

function validateCoordinatorUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("KIWIMU_COORDINATOR_URL must be a valid Redis/Valkey URL");
  }
  if (!["redis:", "rediss:", "valkey:"].includes(parsed.protocol)) {
    throw new Error("KIWIMU_COORDINATOR_URL must use redis://, rediss://, or valkey://");
  }
}

function isRedisConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  if (
    code === "ERR_REDIS_CONNECTION_CLOSED" ||
    code === "ERR_REDIS_CONNECTION_TIMEOUT" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE"
  ) return true;
  return /connection (?:has )?(?:failed|closed|timed? ?out)|connection timeout|socket (?:closed|reset)|ECONN(?:REFUSED|RESET)/i
    .test(error.message);
}

class CoordinatorDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorDeadlineError";
  }
}

async function withDeadline<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CoordinatorDeadlineError(message)), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function encodeKeyPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function optionalNow(value: number | undefined): string {
  if (value === undefined) return "";
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("timestamp must be a non-negative safe integer");
  return String(value);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Unexpected coordinator response");
  return value;
}

function asNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Unexpected numeric coordinator response");
  return parsed;
}

function asSafeInteger(value: unknown, label: string): number {
  const parsed = asNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${label}`);
  return parsed;
}
