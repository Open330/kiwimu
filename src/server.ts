import { join } from "path";
import { existsSync } from "fs";
import { DB_FILE, loadConfig } from "./config";
import { Store } from "./store";
import type { ContentIndex } from "./services/index-generator";
import { isPrivateIp } from "./net";
import { detectServerUploadCapabilities } from "./ingest/capabilities";
import { readBoundedInteger } from "./services/server-guards";
import { cleanupOrphanedGenerationFigures } from "./services/figure-maintenance";
import {
  SqliteDataVersion,
  type RuntimeLease,
} from "./services/runtime-state";
import {
  createRuntimeCoordinator,
  RuntimeCoordinatorUnavailableError,
  type RuntimeCoordinator,
} from "./services/runtime-coordinator";
import { loadOrCreateAuthToken, resolveRequestSecurity, ServerAuth } from "./server/auth";
import { apiJson } from "./server/http";
import {
  LeaseOwnershipLostError,
  ServerTaskDrain,
  serverDrainingResponse,
  type LeaseHeartbeat,
} from "./server/runtime";
import { serveStaticRequest } from "./server/static";
import { handleAdminRoutes } from "./server/routes/admin";
import { handleContentRoutes } from "./server/routes/content";
import { handleIngestRoutes } from "./server/routes/ingest";
import { handleReadRoutes } from "./server/routes/read";

const MAX_SHUTDOWN_DRAIN_SECONDS = 26;
type ServerShutdown = () => Promise<void>;
const registeredServerShutdowns = new Set<ServerShutdown>();
let processTermination: Promise<void> | null = null;
let processHandlersInstalled = false;

export function readShutdownDrainSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 20;
  if (!/^\d+$/.test(value.trim())) {
    throw new RangeError("KIWIMU_SHUTDOWN_DRAIN_SECONDS must be an integer from 1 to 26");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SHUTDOWN_DRAIN_SECONDS) {
    throw new RangeError("KIWIMU_SHUTDOWN_DRAIN_SECONDS must be an integer from 1 to 26");
  }
  return parsed;
}

function removeProcessLifecycleHandlers(): void {
  if (!processHandlersInstalled) return;
  processHandlersInstalled = false;
  process.off("SIGTERM", handleTerminationSignal);
  process.off("SIGINT", handleTerminationSignal);
  process.off("beforeExit", handleBeforeExit);
}

function handleTerminationSignal(): void {
  // Keep this persistent handler installed throughout the whole drain. A
  // repeated signal therefore remains idempotent instead of reverting to the
  // operating system's default immediate exit.
  if (processTermination) return;
  processTermination = (async () => {
    const results = await Promise.allSettled(
      [...registeredServerShutdowns].map((shutdown) => shutdown()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    removeProcessLifecycleHandlers();
    if (failures.length > 0) {
      console.error("Failed to shut down Kiwi Mu cleanly:", new AggregateError(failures));
      process.exit(1);
    }
    process.exit(0);
  })();
}

function handleBeforeExit(): void {
  for (const shutdown of [...registeredServerShutdowns]) void shutdown();
}

function registerServerShutdown(shutdown: ServerShutdown): () => void {
  registeredServerShutdowns.add(shutdown);
  if (!processHandlersInstalled) {
    processHandlersInstalled = true;
    process.on("SIGTERM", handleTerminationSignal);
    process.on("SIGINT", handleTerminationSignal);
    process.on("beforeExit", handleBeforeExit);
  }
  return () => {
    registeredServerShutdowns.delete(shutdown);
    // During process termination the handlers must remain until every server
    // in the captured set has settled. Otherwise a second signal can preempt a
    // different server that is still draining.
    if (registeredServerShutdowns.size === 0 && processTermination === null) {
      removeProcessLifecycleHandlers();
    }
  };
}

export function buildServerStartupMessages(
  hostname: string,
  port: number,
  tokenFile: string,
  usesEnvironmentToken: boolean,
): string[] {
  const displayHostname = hostname === "0.0.0.0" ? "localhost" : hostname;
  const tokenLocation = usesEnvironmentToken ? "KIWIMU_AUTH_TOKEN 환경 변수" : tokenFile;
  const messages = [
    "\x1b[32m🥝 Kiwi Mu 서버 시작!\x1b[0m",
    `  http://${displayHostname}:${port}`,
    `  관리 페이지: http://${displayHostname}:${port}/manage`,
    `  인증 토큰 위치: ${tokenLocation}`,
    "  토큰을 관리 페이지의 token 쿼리 또는 Authorization: Bearer 헤더에 사용하세요.",
  ];
  if (hostname === "0.0.0.0") messages.push("  네트워크에 공개됨 (0.0.0.0)");
  messages.push("  웹에서 문서 추가 가능합니다.\n");
  return messages;
}

export function serverErrorResponse(error: unknown): Response {
  if (error instanceof RuntimeCoordinatorUnavailableError) {
    return apiJson(
      { error: "Runtime coordinator is temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }
  console.error(`Unhandled server error: ${error instanceof Error ? error.message : String(error)}`);
  return apiJson({ error: "Internal Server Error" }, { status: 500 });
}

export async function startServer(root: string, port: number, host: string): Promise<void> {
  const config = loadConfig(root);
  const siteDir = join(root, config.build.output_dir);
  const siteIndex = join(siteDir, "index.html");
  if (!existsSync(siteIndex)) {
    throw new Error(`Built site is missing: ${siteIndex}. Run 'kiwimu build' before serving.`);
  }

  const ASK_RATE_LIMIT = 10; // max requests
  const ASK_RATE_WINDOW = 60_000; // per minute
  const trustProxy = process.env.KIWI_TRUST_PROXY === "true";
  const forceExternalHttps = process.env.KIWIMU_EXTERNAL_HTTPS === "true";
  const CONTENT_LEASE_RESOURCE = "content-mutation";
  const UPLOAD_LEASE_RESOURCE = "upload-admission";
  const LEASE_TTL_MS = readBoundedInteger(process.env.KIWIMU_LEASE_TTL_SECONDS, 300, 30, 3600) * 1000;
  const TASK_HEARTBEAT_TTL_MS = readBoundedInteger(process.env.KIWIMU_TASK_TTL_SECONDS, 90, 15, 600) * 1000;
  const SHUTDOWN_DRAIN_TIMEOUT_MS = readShutdownDrainSeconds(
    process.env.KIWIMU_SHUTDOWN_DRAIN_SECONDS,
  ) * 1000;
  const UPLOAD_CONCURRENCY = readBoundedInteger(process.env.KIWIMU_UPLOAD_CONCURRENCY, 1, 1, 4);
  const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
  const MAX_UPLOAD_BODY_SIZE = 51 * 1024 * 1024;
  const uploadCapabilities = detectServerUploadCapabilities();
  const hostname = host;
  const tokenFile = join(root, ".kiwi-token");
  const auth = new ServerAuth(loadOrCreateAuthToken(tokenFile, process.env.KIWIMU_AUTH_TOKEN));
  const taskDrain = new ServerTaskDrain();

  // TLS: auto-detect cert files for HTTPS
  const certPaths = [
    { cert: join(root, "certs", "fullchain.pem"), key: join(root, "certs", "privkey.pem") },
    { cert: "/etc/letsencrypt/live/internal.jiun.dev/fullchain.pem", key: "/etc/letsencrypt/live/internal.jiun.dev/privkey.pem" },
    { cert: "/certs/fullchain.pem", key: "/certs/privkey.pem" },
  ];
  const tlsConfig = certPaths.find(p => existsSync(p.cert) && existsSync(p.key));

  const store = new Store(join(root, DB_FILE));
  const maintainGenerationFigures = () => {
    const result = cleanupOrphanedGenerationFigures(store, root);
    if (result.failures > 0) {
      console.error(`\x1b[33m⚠ generation figure 정리 실패 ${result.failures}건\x1b[0m`);
    }
  };
  maintainGenerationFigures();
  const runtimeState = await createRuntimeCoordinator(root).catch(error => {
    store.close();
    throw error;
  });
  let contentDbRevision!: SqliteDataVersion;
  try {
    contentDbRevision = new SqliteDataVersion(join(root, DB_FILE));
    const rememberedContentFence = store.getActiveContentFence("content-mutation");
    if (rememberedContentFence) {
      await runtimeState.ensureLeaseFencingToken("content-mutation", rememberedContentFence.fencingToken);
    }
    await runtimeState.markAbandonedTasks();
    await runtimeState.cleanup();
  } catch (error) {
    contentDbRevision?.close();
    store.close();
    await runtimeState.close();
    throw error;
  }

  let resourcesClosed = false;
  const closeResources = async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    const errors: unknown[] = [];
    try { store.close(); } catch (error) { errors.push(error) }
    try { await runtimeState.close(); } catch (error) { errors.push(error) }
    try { contentDbRevision.close(); } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close server resources");
  };
  // Cached content index for /api/index
  const cachedIndexes = new Map<boolean, { data: ContentIndex; revision: number; dataVersion: number }>();

  const maintenanceTimer = setInterval(async () => {
    try {
      await runtimeState.cleanup();
      maintainGenerationFigures();
    } catch (error) {
      console.error(`\x1b[33m⚠ 런타임 상태 정리 실패: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
    }
  }, 30_000);
  maintenanceTimer.unref();

  // Forwarded addresses are attacker-controlled unless deployment explicitly
  // opts into a trusted reverse proxy. The safe default may group proxied
  // clients into one bucket, but it cannot be bypassed by rotating XFF values.
  function rateLimitKey(req: Request, server: { requestIP(req: Request): { address: string } | null }): string {
    const socketIp = server.requestIP(req)?.address || "";
    if (trustProxy && socketIp && isPrivateIp(socketIp)) {
      const xff = req.headers.get("x-forwarded-for");
      if (xff) return xff.split(",")[0]!.trim();
    }
    return socketIp || "local";
  }

  function updateOwnedLeaseStatus(
    heartbeat: LeaseHeartbeat,
    lease: RuntimeLease,
    status: string,
  ): Promise<void> {
    return updateLeaseStatus(runtimeState, heartbeat, lease, status, LEASE_TTL_MS);
  }

  async function updateLeaseStatus(
    coordinator: RuntimeCoordinator,
    heartbeat: LeaseHeartbeat,
    lease: RuntimeLease,
    status: string,
    ttlMs: number,
  ): Promise<void> {
    await heartbeat.assertOwned();
    if (await coordinator.updateLeaseStatus(lease, status, ttlMs)) return;
    await heartbeat.renewNow();
    await heartbeat.assertOwned();
    throw new LeaseOwnershipLostError(lease, "status update rejected");
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
    port,
    hostname,
    maxRequestBodySize: 51 * 1024 * 1024,
    ...(tlsConfig ? { tls: { cert: Bun.file(tlsConfig.cert), key: Bun.file(tlsConfig.key) } } : {}),
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/health/live" && req.method === "GET") {
        return apiJson({ status: "ok" });
      }
      if (url.pathname === "/health/ready" && req.method === "GET") {
        try {
          if (!taskDrain.isAccepting) throw new Error("server is draining");
          if (!existsSync(siteIndex)) throw new Error("built site is missing");
          contentDbRevision.current();
          await runtimeState.getActiveLease(CONTENT_LEASE_RESOURCE);
          return apiJson({ status: "ready" });
        } catch {
          return apiJson({ status: "not_ready" }, { status: 503, headers: { "Retry-After": "1" } });
        }
      }

      const requestSecurity = resolveRequestSecurity(req, url, {
        forceHttps: forceExternalHttps,
        trustProxy,
        peerAddress: server.requestIP(req)?.address,
      });

      const pageTokenRedirect = auth.pageTokenRedirect(req, url, requestSecurity.secure);
      if (pageTokenRedirect) return pageTokenRedirect;

      // ── Auth middleware for /api/* and /admin ──
      if (url.pathname.startsWith("/api/") || url.pathname === "/manage" || url.pathname === "/activity") {
        if (!auth.isRequestAuthorized(req, url, requestSecurity.origin)) {
          return apiJson({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
        }
      }

      const isCostlyRead = req.method === "GET" && (
        url.pathname === "/api/search" ||
        (url.pathname === "/api/index" && url.searchParams.get("llm") === "true")
      );
      if (isCostlyRead && !auth.isCostlyReadAuthorized(req, url, requestSecurity.origin)) {
        return apiJson({ error: "Forbidden" }, { status: 403 });
      }

      const isMutationRequest = req.method === "POST" && url.pathname.startsWith("/api/");
      if (isMutationRequest && !taskDrain.isAccepting) {
        return serverDrainingResponse();
      }

      const dispatchRequest = async (): Promise<Response> => {
      // ── API endpoints ──

      const ingestResponse = await handleIngestRoutes(req, url, {
        root,
        store,
        runtimeState,
        contentLeaseResource: CONTENT_LEASE_RESOURCE,
        uploadLeaseResource: UPLOAD_LEASE_RESOURCE,
        leaseTtlMs: LEASE_TTL_MS,
        taskHeartbeatTtlMs: TASK_HEARTBEAT_TTL_MS,
        uploadConcurrency: UPLOAD_CONCURRENCY,
        maxUploadSize: MAX_UPLOAD_SIZE,
        maxUploadBodySize: MAX_UPLOAD_BODY_SIZE,
        uploadCapabilities,
        updateOwnedLeaseStatus,
        canStartLongTask: () => taskDrain.isAccepting,
        trackBackgroundTask: (completion, onTimeout) => {
          taskDrain.track(completion, onTimeout);
        },
      });
      if (ingestResponse) return ingestResponse;

      const adminResponse = await handleAdminRoutes(req, url, {
        root,
        config,
        store,
        runtimeState,
        cachedIndexes,
        contentLeaseResource: CONTENT_LEASE_RESOURCE,
        leaseTtlMs: LEASE_TTL_MS,
        taskHeartbeatTtlMs: TASK_HEARTBEAT_TTL_MS,
        supportedUploadExtensions: uploadCapabilities.supportedExtensions,
        canStartLongTask: () => taskDrain.isAccepting,
        trackBackgroundTask: (completion, onTimeout) => {
          taskDrain.track(completion, onTimeout);
        },
      });
      if (adminResponse) return adminResponse;

      const contentResponse = await handleContentRoutes(req, url, server, {
        root,
        store,
        runtimeState,
        contentLeaseResource: CONTENT_LEASE_RESOURCE,
        leaseTtlMs: LEASE_TTL_MS,
        taskHeartbeatTtlMs: TASK_HEARTBEAT_TTL_MS,
        askRateLimit: ASK_RATE_LIMIT,
        askRateWindow: ASK_RATE_WINDOW,
        rateLimitKey,
        canStartLongTask: () => taskDrain.isAccepting,
        trackBackgroundTask: (completion, onTimeout) => {
          taskDrain.track(completion, onTimeout);
        },
      });
      if (contentResponse) return contentResponse;

      const readResponse = await handleReadRoutes(req, url, server, {
        root,
        config,
        store,
        runtimeState,
        contentDbRevision,
        cachedIndexes,
        contentLeaseResource: CONTENT_LEASE_RESOURCE,
        askRateLimit: ASK_RATE_LIMIT,
        askRateWindow: ASK_RATE_WINDOW,
        rateLimitKey,
        canStartLongTask: () => taskDrain.isAccepting,
      });
      if (readResponse) return readResponse;

      if (url.pathname.startsWith("/api/")) {
        const allowedMethods = new Map<string, string>([
          ["/api/upload", "POST"], ["/api/add", "POST"], ["/api/settings", "GET, POST"],
          ["/api/personas", "GET, POST"], ["/api/build", "POST"], ["/api/ask", "POST"],
          ["/api/ask/status", "GET"], ["/api/promote", "POST"], ["/api/search", "GET"],
          ["/api/ask-wiki", "POST"], ["/api/lint", "GET"], ["/api/index", "GET"],
          ["/api/status", "GET"], ["/api/page/edit", "POST"], ["/api/provenance", "GET"],
          ["/api/activity", "GET"],
        ]);
        const dynamicKnown = /^\/api\/(?:pages|sources)\/\d+\/citations$/.test(url.pathname) ||
          /^\/api\/tasks\/[^/]+$/.test(url.pathname) ||
          (url.pathname.startsWith("/api/page/") && url.pathname !== "/api/page/edit");
        const allow = allowedMethods.get(url.pathname) ?? (dynamicKnown ? "GET" : null);
        if (allow) {
          return apiJson({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: allow } });
        }
        return apiJson({ error: "Not Found" }, { status: 404 });
      }

      return serveStaticRequest({
        request: req,
        url,
        siteDir,
        isAuthenticated: (request, requestUrl) => auth.isAuthenticated(request, requestUrl),
      });
      };

      const response = dispatchRequest();
      // Health probes are intentionally handled above. Every accepted API
      // request joins the drain, including potentially slow authenticated GET
      // reads such as index generation and semantic search. Static Response
      // creation alone cannot represent completion of its streamed body.
      return url.pathname.startsWith("/api/") ? taskDrain.track(response) : response;
    },
      error: serverErrorResponse,
    });
  } catch (error) {
    clearInterval(maintenanceTimer);
    try {
      await closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Server startup and resource cleanup failed");
    }
    throw error;
  }

  const startupMessages = buildServerStartupMessages(
    hostname,
    server.port ?? port,
    tokenFile,
    Boolean(process.env.KIWIMU_AUTH_TOKEN?.trim()),
  );
  for (const message of startupMessages) console.log(message);
  if (tlsConfig) console.log(`  🔒 HTTPS 활성화 (${tlsConfig.cert})`);

  let shutdownPromise: Promise<void> | null = null;
  let unregisterShutdown = () => {};
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    const running = (async () => {
      taskDrain.beginDrain();
      clearInterval(maintenanceTimer);
      const drained = await taskDrain.waitForDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
      if (!drained) {
        console.warn(
          `Shutdown drain timed out with ${taskDrain.activeCount} active operation(s); forcing server stop`,
        );
        // Best-effort terminal state prevents Redis-backed processing tasks
        // from appearing live until their heartbeat TTL after this process exits.
        await taskDrain.markTimedOut(1_000);
      }
      // Close active sockets only after the bounded application-work drain.
      // A successful drain uses Bun's graceful listener stop; the timeout path
      // force-closes connections so shutdown remains bounded.
      if (drained) {
        const gracefulStop = server.stop(false);
        const stoppedGracefully = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => resolve(false), 1_000);
          void gracefulStop.then(
            () => {
              clearTimeout(timer);
              resolve(true);
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            },
          );
        });
        if (!stoppedGracefully) await server.stop(true);
      } else {
        await server.stop(true);
      }
      await closeResources();
    })().finally(() => {
      unregisterShutdown();
    });
    shutdownPromise = running;
    return running;
  };
  unregisterShutdown = registerServerShutdown(shutdown);
}
