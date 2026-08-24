import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildContentSecurityPolicy } from "../build/csp";
import { RuntimeState, type RuntimeLease } from "../services/runtime-state";
import { buildServerStartupMessages } from "../server";
import {
  AUTH_COOKIE_NAME,
  ServerAuth,
  loadOrCreateAuthToken,
  readCookie,
  resolveRequestSecurity,
  safeEqual,
} from "./auth";
import { htmlResponse } from "./http";
import {
  LeaseOwnershipLostError,
  ServerTaskDrain,
  TaskOwnershipLostError,
  acquireContentLease,
  conflictResponse,
  keepLeaseAlive,
  keepTaskAlive,
  startDetachedContentJob,
  startTrackedContentJob,
  uploadBusyResponse,
} from "./runtime";
import { StaleContentFenceError } from "../repositories/content-fence-repository";
import { injectLiveMarker, serveStaticRequest } from "./static";

const temporaryDirectories: string[] = [];

describe("server task drain", () => {
  test("closes admission idempotently and drains fulfilled or rejected work", async () => {
    const drain = new ServerTaskDrain();
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => { resolveWork = resolve; });
    drain.track(work);
    drain.track(Promise.reject(new Error("expected job failure")));

    expect(drain.isAccepting).toBeTrue();
    expect(drain.activeCount).toBe(2);
    drain.beginDrain();
    drain.beginDrain();
    expect(drain.isAccepting).toBeFalse();

    resolveWork();
    expect(await drain.waitForDrain(100)).toBeTrue();
    expect(drain.activeCount).toBe(0);
  });

  test("includes background work transferred by an admitted request", async () => {
    const drain = new ServerTaskDrain();
    let finishBackground!: () => void;
    const background = new Promise<void>((resolve) => { finishBackground = resolve; });
    const request = Promise.resolve().then(() => {
      drain.track(background);
    });
    drain.track(request);
    drain.beginDrain();

    await request;
    await Bun.sleep(0);
    expect(drain.activeCount).toBe(1);
    const waiting = drain.waitForDrain(100);
    await Bun.sleep(5);
    finishBackground();
    expect(await waiting).toBeTrue();
  });

  test("bounds the drain wait without discarding active work", async () => {
    const drain = new ServerTaskDrain();
    let finish!: () => void;
    drain.track(new Promise<void>((resolve) => { finish = resolve; }));
    drain.beginDrain();

    expect(await drain.waitForDrain(5)).toBeFalse();
    expect(drain.activeCount).toBe(1);
    finish();
    expect(await drain.waitForDrain(100)).toBeTrue();
  });

  test("runs timeout cleanup only for work that is still active", async () => {
    const drain = new ServerTaskDrain();
    let finish!: () => void;
    let cleanups = 0;
    drain.track(
      new Promise<void>((resolve) => { finish = resolve; }),
      async () => { cleanups += 1; },
    );
    drain.track(Promise.resolve(), async () => { cleanups += 100; });
    await Bun.sleep(0);

    await drain.markTimedOut();
    expect(cleanups).toBe(1);
    finish();
    expect(await drain.waitForDrain(100)).toBeTrue();
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kiwimu-server-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("server authentication helpers", () => {
  const token = "0123456789abcdef0123456789abcdef";

  test("loads an environment token or persists a stable generated token", () => {
    const tokenFile = join(makeTemporaryDirectory(), ".kiwi-token");
    expect(loadOrCreateAuthToken(tokenFile, `  ${token}  `)).toBe(token);

    const generated = loadOrCreateAuthToken(tokenFile);
    expect(generated.length).toBeGreaterThanOrEqual(16);
    expect(readFileSync(tokenFile, "utf8")).toBe(generated);
    expect(loadOrCreateAuthToken(tokenFile)).toBe(generated);

    const permissiveTokenFile = join(makeTemporaryDirectory(), ".kiwi-token");
    writeFileSync(permissiveTokenFile, token, { mode: 0o644 });
    expect(loadOrCreateAuthToken(permissiveTokenFile)).toBe(token);
    expect(statSync(permissiveTokenFile).mode & 0o777).toBe(0o600);

    const partialTokenFile = join(makeTemporaryDirectory(), ".kiwi-token");
    writeFileSync(partialTokenFile, "12345678-1234-1234", { mode: 0o600 });
    const repaired = loadOrCreateAuthToken(partialTokenFile);
    expect(repaired).not.toBe("12345678-1234-1234");
    expect(repaired).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  });

  test("fails fast when a configured auth token is too short", () => {
    const tokenFile = join(makeTemporaryDirectory(), ".kiwi-token");
    expect(() => loadOrCreateAuthToken(tokenFile, "too-short")).toThrow(
      "KIWIMU_AUTH_TOKEN must be at least 16 characters",
    );
    expect(() => readFileSync(tokenFile, "utf8")).toThrow();
  });

  test.skipIf(process.platform === "win32")("rejects linked or non-regular token paths without touching their targets", () => {
    const root = makeTemporaryDirectory();
    const outsideToken = join(root, "outside-token");
    const tokenFile = join(root, ".kiwi-token");
    writeFileSync(outsideToken, token, { mode: 0o644 });
    chmodSync(outsideToken, 0o644);
    symlinkSync(outsideToken, tokenFile);

    expect(() => loadOrCreateAuthToken(tokenFile)).toThrow("regular file");
    expect(readFileSync(outsideToken, "utf8")).toBe(token);
    expect(statSync(outsideToken).mode & 0o777).toBe(0o644);

    rmSync(tokenFile);
    mkdirSync(tokenFile);
    expect(() => loadOrCreateAuthToken(tokenFile)).toThrow("regular file");
    expect(statSync(tokenFile).isDirectory()).toBeTrue();
  });

  test("concurrent cold starts repair one empty token file to one shared token", async () => {
    const tokenFile = join(makeTemporaryDirectory(), ".kiwi-token");
    writeFileSync(tokenFile, "", { mode: 0o666 });
    const authModuleUrl = pathToFileURL(join(import.meta.dir, "auth.ts")).href;
    const code = [
      `import { loadOrCreateAuthToken } from ${JSON.stringify(authModuleUrl)};`,
      `console.log(loadOrCreateAuthToken(${JSON.stringify(tokenFile)}));`,
    ].join("\n");
    const processes = Array.from(
      { length: 40 },
      () => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }),
    );
    const outputPromises = processes.map((process) => new Response(process.stdout).text());
    const errorPromises = processes.map((process) => new Response(process.stderr).text());
    const exitCodes = await Promise.all(processes.map((process) => process.exited));
    const outputs = await Promise.all(outputPromises);
    const errors = await Promise.all(errorPromises);

    expect(exitCodes).toEqual(Array.from({ length: 40 }, () => 0));
    if (exitCodes.some((code) => code !== 0)) {
      throw new Error(`token subprocess failed: ${errors.join("\n")}`);
    }
    const tokens = new Set(outputs.map((output) => output.trim()));
    expect(tokens.size).toBe(1);
    const sharedToken = tokens.values().next().value;
    if (!sharedToken) throw new Error("token subprocesses returned no token");
    expect(sharedToken).toBe(readFileSync(tokenFile, "utf8"));
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  }, 15_000);

  test("authenticates query, bearer, and encoded HttpOnly-cookie credentials", () => {
    const auth = new ServerAuth(token);
    const queryUrl = new URL(`http://localhost/manage?token=${token}`);
    expect(auth.isAuthenticated(new Request(queryUrl), queryUrl)).toBeTrue();

    const bearerRequest = new Request("http://localhost/api/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(auth.isAuthenticated(bearerRequest, new URL(bearerRequest.url))).toBeTrue();

    const cookieRequest = new Request("http://localhost/manage", {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; other=value` },
    });
    expect(readCookie(cookieRequest, AUTH_COOKIE_NAME)).toBe(token);
    expect(auth.isAuthenticated(cookieRequest, new URL(cookieRequest.url))).toBeTrue();
    expect(safeEqual(`${token}x`, token)).toBeFalse();
  });

  test("requires exact same-origin for unsafe cookie auth while preserving bearer clients", () => {
    const auth = new ServerAuth(token);
    const url = new URL("https://wiki.example/api/settings");
    const cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`;

    const sameOrigin = new Request(url, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://wiki.example" },
    });
    expect(auth.isRequestAuthorized(sameOrigin, url)).toBeTrue();

    for (const origin of [undefined, "null", "https://evil.example", "https://evil.wiki.example"]) {
      const request = new Request(url, {
        method: "POST",
        headers: {
          Cookie: cookie,
          ...(origin === undefined ? {} : { Origin: origin }),
        },
      });
      expect(auth.isRequestAuthorized(request, url)).toBeFalse();
    }

    const bearer = new Request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://evil.example",
      },
    });
    expect(auth.isRequestAuthorized(bearer, url)).toBeTrue();

    const cookieGet = new Request(url, { headers: { Cookie: cookie } });
    expect(auth.isRequestAuthorized(cookieGet, url)).toBeTrue();
  });

  test("requires a same-origin browser context for cost-bearing cookie GETs", () => {
    const auth = new ServerAuth(token);
    const url = new URL("https://wiki.example/api/search?q=costly");
    const cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`;

    const crossSiteHeaders: HeadersInit[] = [
      { Cookie: cookie },
      { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
      { Cookie: cookie, Origin: "null", "Sec-Fetch-Site": "same-origin" },
      { Cookie: cookie, Origin: "https://evil.example" },
    ];
    for (const headers of crossSiteHeaders) {
      const request = new Request(url, { headers });
      expect(auth.isCostlyReadAuthorized(request, url)).toBeFalse();
    }

    const sameOriginFetch = new Request(url, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    expect(auth.isCostlyReadAuthorized(sameOriginFetch, url)).toBeTrue();

    const sameOriginHeader = new Request(url, {
      headers: { Cookie: cookie, Origin: "https://wiki.example" },
    });
    expect(auth.isCostlyReadAuthorized(sameOriginHeader, url)).toBeTrue();

    const bearer = new Request(url, {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" },
    });
    expect(auth.isCostlyReadAuthorized(bearer, url)).toBeTrue();
  });

  test("trusts forwarded HTTPS only for an explicitly trusted private proxy", () => {
    const proxiedRequest = new Request("http://wiki.example/manage", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    const url = new URL(proxiedRequest.url);

    expect(resolveRequestSecurity(proxiedRequest, url)).toEqual({
      secure: false,
      origin: "http://wiki.example",
    });
    expect(resolveRequestSecurity(proxiedRequest, url, {
      trustProxy: true,
      peerAddress: "203.0.113.10",
    })).toEqual({ secure: false, origin: "http://wiki.example" });
    expect(resolveRequestSecurity(proxiedRequest, url, {
      trustProxy: true,
      peerAddress: "172.17.0.2",
    })).toEqual({ secure: true, origin: "https://wiki.example" });
    expect(resolveRequestSecurity(new Request(url), url, { forceHttps: true })).toEqual({
      secure: true,
      origin: "https://wiki.example",
    });
  });

  test("exchanges a valid page query token for a secure cookie without changing API auth", () => {
    const auth = new ServerAuth(token);
    const pageUrl = new URL(`https://localhost/manage?view=all&token=${token}`);
    const redirect = auth.pageTokenRedirect(new Request(pageUrl), pageUrl);

    expect(redirect?.status).toBe(302);
    expect(redirect?.headers.get("Location")).toBe("/manage?view=all");
    expect(redirect?.headers.get("Set-Cookie")).toContain("HttpOnly; Secure");
    expect(redirect?.headers.get("Set-Cookie")).not.toContain(token + "&");

    const apiUrl = new URL(`https://localhost/api/status?token=${token}`);
    expect(auth.pageTokenRedirect(new Request(apiUrl), apiUrl)).toBeNull();

    const invalidUrl = new URL("https://localhost/manage?token=invalid");
    expect(auth.pageTokenRedirect(new Request(invalidUrl), invalidUrl)?.status).toBe(401);

    const proxyUrl = new URL(`http://wiki.example/manage?token=${token}`);
    const proxyRedirect = auth.pageTokenRedirect(new Request(proxyUrl), proxyUrl, true);
    expect(proxyRedirect?.headers.get("Set-Cookie")).toContain("; Secure");
  });

  test("startup diagnostics never expose the auth token or a token-bearing URL", () => {
    const tokenFile = "/srv/kiwimu/.kiwi-token";
    const generatedTokenMessages = buildServerStartupMessages("0.0.0.0", 3000, tokenFile, false);
    const environmentTokenMessages = buildServerStartupMessages("127.0.0.1", 4000, tokenFile, true);

    expect(generatedTokenMessages).toContain("  관리 페이지: http://localhost:3000/manage");
    expect(generatedTokenMessages).toContain(`  인증 토큰 위치: ${tokenFile}`);
    expect(environmentTokenMessages).toContain("  인증 토큰 위치: KIWIMU_AUTH_TOKEN 환경 변수");
    expect([...generatedTokenMessages, ...environmentTokenMessages].join("\n")).not.toContain("?token=");

    const serverSource = readFileSync(join(import.meta.dir, "../server.ts"), "utf8");
    expect(serverSource).not.toMatch(/console\.(?:log|info|warn|error)\([^;]*auth\.token/);
    expect(serverSource).not.toContain("/manage?token=");
  });
});

describe("server HTML and static response helpers", () => {
  test("derives CSP from the final HTML and never weakens script-src", async () => {
    const html = "<!doctype html><html><head></head><body><script>window.ready = true;</script></body></html>";
    const response = htmlResponse(html);
    const csp = response.headers.get("Content-Security-Policy") || "";
    const scriptDirective = csp.split(";").find((directive) => directive.trim().startsWith("script-src"));

    expect(csp).toBe(buildContentSecurityPolicy(html));
    expect(scriptDirective?.trim()).toBe("script-src 'self'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("http:");
    expect(scriptDirective).not.toContain("https:");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe(html);
  });

  test("injects the live marker before computing authenticated static-page CSP", async () => {
    const siteDir = makeTemporaryDirectory();
    const originalHtml = "<!doctype html><html><head></head><body><script>window.page = 1;</script></body></html>";
    await Bun.write(join(siteDir, "index.html"), originalHtml);

    const request = new Request("http://localhost/");
    const response = await serveStaticRequest({
      request,
      url: new URL(request.url),
      siteDir,
      isAuthenticated: () => true,
    });
    const finalHtml = await response.text();

    expect(finalHtml).toContain('name="kiwi-live"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      buildContentSecurityPolicy(finalHtml),
    );
  });

  test("keeps public HTML cache semantics and marker injection idempotent", async () => {
    const siteDir = makeTemporaryDirectory();
    const html = "<!doctype html><html><head></head><body>Public</body></html>";
    await Bun.write(join(siteDir, "index.html"), html);

    const request = new Request("http://localhost/index.html");
    const response = await serveStaticRequest({
      request,
      url: new URL(request.url),
      siteDir,
      isAuthenticated: () => false,
    });

    expect(await response.text()).toBe(html);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    const marked = injectLiveMarker(html);
    expect(injectLiveMarker(marked)).toBe(marked);
  });

  test("never follows a static-site symlink outside the configured root", async () => {
    const parent = makeTemporaryDirectory();
    const siteDir = join(parent, "site");
    const outside = join(parent, "outside-secret.txt");
    mkdirSync(siteDir);
    await Bun.write(join(siteDir, "inside.txt"), "inside");
    await Bun.write(outside, "outside secret");
    symlinkSync(outside, join(siteDir, "leak.txt"));

    const leakedRequest = new Request("http://localhost/leak.txt");
    const leaked = await serveStaticRequest({
      request: leakedRequest,
      url: new URL(leakedRequest.url),
      siteDir,
      isAuthenticated: () => false,
    });
    expect(leaked.status).toBe(403);
    expect(await leaked.text()).not.toContain("outside secret");

    const insideRequest = new Request("http://localhost/inside.txt");
    const inside = await serveStaticRequest({
      request: insideRequest,
      url: new URL(insideRequest.url),
      siteDir,
      isAuthenticated: () => false,
    });
    expect(inside.status).toBe(200);
    expect(await inside.text()).toBe("inside");
  });

  test("revalidates fixed-name static assets with entity tags", async () => {
    const siteDir = makeTemporaryDirectory();
    const asset = "window.kiwi = true;\n".repeat(100);
    await Bun.write(join(siteDir, "app.js"), asset);

    const firstRequest = new Request("http://localhost/app.js");
    const first = await serveStaticRequest({
      request: firstRequest,
      url: new URL(firstRequest.url),
      siteDir,
      isAuthenticated: () => false,
    });
    const entityTag = first.headers.get("ETag");

    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("public, no-cache");
    expect(entityTag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(first.headers.get("Last-Modified")).not.toBeNull();
    expect(await first.text()).toBe(asset);

    const conditionalRequest = new Request("http://localhost/app.js", {
      headers: { "If-None-Match": entityTag! },
    });
    const conditional = await serveStaticRequest({
      request: conditionalRequest,
      url: new URL(conditionalRequest.url),
      siteDir,
      isAuthenticated: () => false,
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
  });

  test("streams compressible static assets with negotiated gzip", async () => {
    const siteDir = makeTemporaryDirectory();
    const asset = "const diagram = 'kiwi';\n".repeat(500);
    await Bun.write(join(siteDir, "diagram.js"), asset);

    const request = new Request("http://localhost/diagram.js", {
      headers: { "Accept-Encoding": "br, gzip;q=0.8" },
    });
    const response = await serveStaticRequest({
      request,
      url: new URL(request.url),
      siteDir,
      isAuthenticated: () => false,
    });

    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("Vary")).toBe("Accept-Encoding");
    if (!response.body) throw new Error("expected compressed response body");
    const decompressed = await new Response(
      response.body.pipeThrough(new DecompressionStream("gzip")),
    ).text();
    expect(decompressed).toBe(asset);

    const disabledRequest = new Request("http://localhost/diagram.js", {
      headers: { "Accept-Encoding": "gzip;q=0, *;q=1" },
    });
    const disabled = await serveStaticRequest({
      request: disabledRequest,
      url: new URL(disabledRequest.url),
      siteDir,
      isAuthenticated: () => false,
    });
    expect(disabled.headers.get("Content-Encoding")).toBeNull();
    expect(await disabled.text()).toBe(asset);
  });
});

describe("runtime response and heartbeat helpers", () => {
  test("preserves conflict and upload retry response contracts", async () => {
    const admission = {
      acquired: false as const,
      retryAfterSeconds: 7,
      status: "처리 중",
    };
    const conflict = conflictResponse(admission);
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("Retry-After")).toBe("7");
    expect(await conflict.json()).toMatchObject({
      error: "이미 처리 중입니다",
      status: "처리 중",
      retry_after_seconds: 7,
    });

    const upload = uploadBusyResponse(admission);
    expect(upload.status).toBe(429);
    expect(upload.headers.get("Retry-After")).toBe("7");
  });

  test("lease stop is idempotently owned by the returned cleanup boundary", async () => {
    const lease: RuntimeLease = { resource: "content", slot: 0, ownerToken: "owner", fencingToken: 1 };
    let releases = 0;
    const runtime = {
      isLeaseOwned: () => true,
      renewLease: () => true,
      releaseLease: () => {
        releases += 1;
        return true;
      },
    };

    const heartbeat = keepLeaseAlive(runtime, lease, 30_000);
    await heartbeat.assertOwned();
    await heartbeat.stop();
    await heartbeat.stop();
    expect(releases).toBe(1);
  });

  test("lease stop waits for an in-flight renewal before releasing", async () => {
    const lease: RuntimeLease = { resource: "content", slot: 0, ownerToken: "owner", fencingToken: 1 };
    let finishRenewal!: (renewed: boolean) => void;
    const renewal = new Promise<boolean>((resolve) => { finishRenewal = resolve; });
    const events: string[] = [];
    const runtime = {
      isLeaseOwned: () => true,
      renewLease: async () => {
        events.push("renew-start");
        const renewed = await renewal;
        events.push("renew-finish");
        return renewed;
      },
      releaseLease: () => {
        events.push("release");
        return true;
      },
    };

    const heartbeat = keepLeaseAlive(runtime, lease, 30_000);
    const renewing = heartbeat.renewNow();
    const firstStop = heartbeat.stop();
    const secondStop = heartbeat.stop();
    await Bun.sleep(0);
    expect(events).toEqual(["renew-start"]);

    finishRenewal(true);
    expect(await renewing).toBeTrue();
    await Promise.all([firstStop, secondStop]);
    expect(events).toEqual(["renew-start", "renew-finish", "release"]);
  });

  test("marks a rejected renewal as lost and fences subsequent work", async () => {
    const lease: RuntimeLease = { resource: "content", slot: 0, ownerToken: "stale", fencingToken: 1 };
    const runtime = {
      isLeaseOwned: () => true,
      renewLease: () => false,
      releaseLease: () => false,
    };
    const heartbeat = keepLeaseAlive(runtime, lease, 30_000);

    expect(await heartbeat.renewNow()).toBeFalse();
    expect(heartbeat.lost).toBeTrue();
    await expect(heartbeat.assertOwned()).rejects.toBeInstanceOf(LeaseOwnershipLostError);
    await expect(heartbeat.assertOwned()).rejects.toThrow("renewal rejected");
    await heartbeat.stop();
  });

  test("marks renewal exceptions and failed ownership checks as lost", async () => {
    const lease: RuntimeLease = { resource: "content", slot: 0, ownerToken: "stale", fencingToken: 1 };
    const renewalFailure = keepLeaseAlive({
      isLeaseOwned: () => true,
      renewLease: () => {
        throw new Error("database unavailable");
      },
      releaseLease: () => false,
    }, lease, 30_000);
    expect(await renewalFailure.renewNow()).toBeFalse();
    await expect(renewalFailure.assertOwned()).rejects.toThrow("renewal failed");
    await renewalFailure.stop();

    const ownershipFailure = keepLeaseAlive({
      isLeaseOwned: () => false,
      renewLease: () => true,
      releaseLease: () => false,
    }, lease, 30_000);
    await expect(ownershipFailure.assertOwned()).rejects.toThrow("ownership check rejected");
    expect(ownershipFailure.lost).toBeTrue();
    await ownershipFailure.stop();
  });

  test("fences a stale heartbeat after another process acquires its expired slot", async () => {
    const runtimeDb = join(makeTemporaryDirectory(), "runtime.db");
    const staleWorker = new RuntimeState(runtimeDb, "stale");
    const replacementWorker = new RuntimeState(runtimeDb, "replacement");
    try {
      const staleAdmission = staleWorker.acquireLease("publish", 1, 1);
      expect(staleAdmission.acquired).toBeTrue();
      if (!staleAdmission.acquired) throw new Error("expected stale lease");
      await Bun.sleep(5);

      const replacementAdmission = replacementWorker.acquireLease("publish", 30_000, 1);
      expect(replacementAdmission.acquired).toBeTrue();
      if (!replacementAdmission.acquired) throw new Error("expected replacement lease");

      const staleHeartbeat = keepLeaseAlive(staleWorker, staleAdmission.lease, 30_000);
      await expect(staleHeartbeat.assertOwned()).rejects.toBeInstanceOf(LeaseOwnershipLostError);
      expect(staleHeartbeat.lost).toBeTrue();
      expect(replacementWorker.isLeaseOwned(replacementAdmission.lease)).toBeTrue();
      await staleHeartbeat.stop();
    } finally {
      staleWorker.close();
      replacementWorker.close();
    }
  });

  test("fast-forwards an reset coordinator from the durable content fence and retries once", async () => {
    let epoch = 0;
    let releases = 0;
    const runtime = {
      acquireLease(resource: string) {
        epoch += 1;
        return {
          acquired: true as const,
          retryAfterSeconds: 0 as const,
          lease: { resource, slot: 0, ownerToken: `owner-${epoch}`, fencingToken: epoch },
        };
      },
      ensureLeaseFencingToken(_resource: string, minimum: number) {
        epoch = Math.max(epoch, minimum);
      },
      isLeaseOwned: () => true,
      renewLease: () => true,
      releaseLease: () => {
        releases += 1;
        return true;
      },
    };
    const durableFence = {
      resource: "content",
      ownerToken: "durable-owner",
      fencingToken: 100,
      epoch: 7,
    };
    const store = {
      getActiveContentFence: () => durableFence,
      activateContentFence(lease: RuntimeLease) {
        if (lease.fencingToken <= durableFence.fencingToken) {
          throw new StaleContentFenceError(lease.resource);
        }
        return { ...lease, epoch: durableFence.epoch + 1 };
      },
    };

    const admission = await acquireContentLease(runtime, store, "content", 30_000, "build");
    expect(admission.acquired).toBeTrue();
    if (!admission.acquired) throw new Error("expected recovered content lease");
    expect(admission.lease.fencingToken).toBe(101);
    expect(admission.fence.epoch).toBe(8);
    expect(releases).toBe(1);
    await admission.heartbeat.stop();
    expect(releases).toBe(2);
  });

  test("task heartbeat loss is observable and fences terminal work", async () => {
    const rejected = keepTaskAlive({ heartbeatTask: () => false }, "task-1", 30_000);
    expect(await rejected.heartbeatNow()).toBeFalse();
    expect(rejected.lost).toBeTrue();
    await expect(rejected.assertOwned()).rejects.toBeInstanceOf(TaskOwnershipLostError);
    rejected.stop();

    const failed = keepTaskAlive({
      heartbeatTask: () => { throw new Error("coordinator unavailable"); },
    }, "task-2", 30_000);
    expect(await failed.heartbeatNow()).toBeFalse();
    await expect(failed.assertOwned()).rejects.toThrow("heartbeat failed");
    failed.stop();
  });

  test("detached jobs release once when the fence assertion throws synchronously", async () => {
    const error = new StaleContentFenceError("content");
    let stops = 0;
    let reports = 0;
    const heartbeat = {
      lost: false,
      renewNow: async () => true,
      assertOwned: async () => {},
      stop: async () => { stops += 1; },
    };
    const store = {
      runWithContentFence() {
        throw error;
      },
    } as Parameters<typeof startDetachedContentJob>[0];
    const fence = { resource: "content", ownerToken: "owner", fencingToken: 1, epoch: 1 };

    await expect(startDetachedContentJob(
      store,
      fence,
      heartbeat,
      async () => {},
      () => { reports += 1; },
    )).rejects.toBe(error);
    expect(stops).toBe(1);
    expect(reports).toBe(0);
  });

  test("detached jobs report async rejection and own exactly one cleanup", async () => {
    const error = new Error("background failed");
    const reports: unknown[] = [];
    let stops = 0;
    const heartbeat = {
      lost: false,
      renewNow: async () => true,
      assertOwned: async () => {},
      stop: async () => { stops += 1; },
    };
    const store = {
      runWithContentFence<T>(_fence: unknown, operation: () => T): T {
        return operation();
      },
    } as Parameters<typeof startDetachedContentJob>[0];
    const fence = { resource: "content", ownerToken: "owner", fencingToken: 1, epoch: 1 };

    const handle = await startDetachedContentJob(
      store,
      fence,
      heartbeat,
      async () => { throw error; },
      (reported) => { reports.push(reported); },
    );
    await handle.completion;
    await handle.completion;

    expect(reports).toEqual([error]);
    expect(stops).toBe(1);
  });

  test("tracked jobs complete a pollable task and stop both heartbeats once", async () => {
    const taskStates = new Map<string, { status: string; result?: unknown; error?: string }>();
    let leaseStops = 0;
    let taskHeartbeats = 0;
    const contentHeartbeat = {
      lost: false,
      renewNow: async () => true,
      assertOwned: async () => {},
      stop: async () => { leaseStops += 1; },
    };
    const runtimeState = {
      async createTask(id: string) { taskStates.set(id, { status: "processing" }); },
      async heartbeatTask() { taskHeartbeats += 1; return true; },
      async completeTask(id: string, result: unknown) {
        taskStates.set(id, { status: "completed", result });
        return true;
      },
      async failTask(id: string, error: string) {
        taskStates.set(id, { status: "error", error });
        return true;
      },
    };
    const store = {
      runWithContentFence<T>(_fence: unknown, operation: () => T): T {
        return operation();
      },
    } as Parameters<typeof startTrackedContentJob>[0]["store"];
    const fence = { resource: "content", ownerToken: "owner", fencingToken: 1, epoch: 1 };

    const handle = await startTrackedContentJob({
      runtimeState,
      store,
      fence,
      contentHeartbeat,
      taskKind: "build",
      taskHeartbeatTtlMs: 3_000,
      taskId: "task-success",
      async operation({ assertOwned }) {
        await assertOwned();
        return { pages: 3 };
      },
      reportError() {},
    });
    await handle.completion;
    const heartbeatCountAfterCompletion = taskHeartbeats;
    await Bun.sleep(1_050);

    expect(handle.taskId).toBe("task-success");
    expect(taskStates.get(handle.taskId)).toEqual({ status: "completed", result: { pages: 3 } });
    expect(leaseStops).toBe(1);
    expect(taskHeartbeats).toBe(heartbeatCountAfterCompletion);
  });

  test("tracked jobs persist async failure and stop both heartbeats once", async () => {
    const taskStates = new Map<string, { status: string; error?: string }>();
    let leaseStops = 0;
    let taskHeartbeats = 0;
    const contentHeartbeat = {
      lost: false,
      renewNow: async () => true,
      assertOwned: async () => {},
      stop: async () => { leaseStops += 1; },
    };
    const runtimeState = {
      async createTask(id: string) { taskStates.set(id, { status: "processing" }); },
      async heartbeatTask() { taskHeartbeats += 1; return true; },
      async completeTask() { return true; },
      async failTask(id: string, error: string) {
        taskStates.set(id, { status: "error", error });
        return true;
      },
    };
    const store = {
      runWithContentFence<T>(_fence: unknown, operation: () => T): T {
        return operation();
      },
    } as Parameters<typeof startTrackedContentJob>[0]["store"];
    const fence = { resource: "content", ownerToken: "owner", fencingToken: 1, epoch: 1 };

    const handle = await startTrackedContentJob({
      runtimeState,
      store,
      fence,
      contentHeartbeat,
      taskKind: "ingest",
      taskHeartbeatTtlMs: 3_000,
      taskId: "task-failure",
      async operation() { throw new Error("pipeline failed"); },
      reportError() {},
    });
    await handle.completion;
    const heartbeatCountAfterCompletion = taskHeartbeats;
    await Bun.sleep(1_050);

    expect(taskStates.get(handle.taskId)).toEqual({ status: "error", error: "pipeline failed" });
    expect(leaseStops).toBe(1);
    expect(taskHeartbeats).toBe(heartbeatCountAfterCompletion);
  });

  test("tracked job interruption fails durable state and releases its content lease", async () => {
    let leaseStops = 0;
    let leaseStopped = false;
    let completionAttempts = 0;
    let taskStatus = "processing";
    let taskError = "";
    let finishOperation!: () => void;
    const pendingOperation = new Promise<void>((resolve) => { finishOperation = resolve; });
    const contentHeartbeat = {
      lost: false,
      renewNow: async () => true,
      assertOwned: async () => {},
      stop: async () => {
        if (leaseStopped) return;
        leaseStopped = true;
        leaseStops += 1;
      },
    };
    const runtimeState = {
      async createTask() {},
      async heartbeatTask() { return true; },
      async completeTask() { completionAttempts += 1; return true; },
      async failTask(_id: string, error: string) {
        taskStatus = "error";
        taskError = error;
        return true;
      },
    };
    const store = {
      runWithContentFence<T>(_fence: unknown, operation: () => T): T {
        return operation();
      },
    } as Parameters<typeof startTrackedContentJob>[0]["store"];
    const handle = await startTrackedContentJob({
      runtimeState,
      store,
      fence: { resource: "content", ownerToken: "owner", fencingToken: 1, epoch: 1 },
      contentHeartbeat,
      taskKind: "build",
      taskHeartbeatTtlMs: 3_000,
      taskId: "task-interrupted",
      operation: async () => pendingOperation,
      reportError() {},
    });

    await handle.interrupt("shutdown timed out");
    await handle.interrupt("shutdown timed out again");
    expect(taskStatus).toBe("error");
    expect(taskError).toBe("shutdown timed out");
    expect(leaseStops).toBe(1);

    finishOperation();
    await handle.completion;
    expect(completionAttempts).toBe(0);
    expect(leaseStops).toBe(1);
  });

  test("tracked job interruption aborts the running operation signal", async () => {
    const reason = "shutdown cancelled I/O";
    let observedSignal: AbortSignal | undefined;
    const contentHeartbeat = {
      lost: false,
      renewNow: async () => true,
      assertOwned: async () => {},
      stop: async () => {},
    };
    const runtimeState = {
      async createTask() {},
      async heartbeatTask() { return true; },
      async completeTask() { return true; },
      async failTask() { return true; },
    };
    const store = {
      runWithContentFence<T>(_fence: unknown, operation: () => T): T { return operation(); },
    } as Parameters<typeof startTrackedContentJob>[0]["store"];
    const handle = await startTrackedContentJob({
      runtimeState,
      store,
      fence: { resource: "content", ownerToken: "owner", fencingToken: 1, epoch: 1 },
      contentHeartbeat,
      taskKind: "ingest",
      taskHeartbeatTtlMs: 3_000,
      taskId: "task-aborted",
      operation: ({ signal }) => {
        observedSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      reportError() {},
    });

    while (!observedSignal) await Bun.sleep(0);
    await handle.interrupt(reason);
    await handle.completion;
    expect(observedSignal?.aborted).toBeTrue();
    expect((observedSignal?.reason as Error).message).toBe(reason);
  });

  test("tracked job start rejection records failure and owns cleanup once", async () => {
    let leaseStops = 0;
    let taskHeartbeats = 0;
    let failure: string | undefined;
    const contentHeartbeat = {
      lost: false,
      renewNow: async () => true,
      assertOwned: async () => {},
      stop: async () => { leaseStops += 1; },
    };
    const runtimeState = {
      async createTask() {},
      async heartbeatTask() { taskHeartbeats += 1; return true; },
      async completeTask() { return true; },
      async failTask(_id: string, error: string) { failure = error; return true; },
    };
    const rejection = new StaleContentFenceError("content");
    const store = {
      runWithContentFence() { throw rejection; },
    } as Parameters<typeof startTrackedContentJob>[0]["store"];
    const fence = { resource: "content", ownerToken: "owner", fencingToken: 1, epoch: 1 };

    await expect(startTrackedContentJob({
      runtimeState,
      store,
      fence,
      contentHeartbeat,
      taskKind: "build",
      taskHeartbeatTtlMs: 3_000,
      taskId: "task-rejected",
      async operation() {},
      reportError() {},
    })).rejects.toBe(rejection);
    await Bun.sleep(1_050);

    expect(failure).toContain("stale");
    expect(leaseStops).toBe(1);
    expect(taskHeartbeats).toBe(0);
  });
});
