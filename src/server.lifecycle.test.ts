import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultConfig, saveConfig } from "./config";
import { RuntimeCoordinatorUnavailableError } from "./services/runtime-coordinator";
import { readShutdownDrainSeconds, serverErrorResponse, startServer } from "./server";

const temporaryDirectories: string[] = [];

function makeTemporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), "kiwimu-lifecycle-"));
  temporaryDirectories.push(root);
  saveConfig(root, defaultConfig("Lifecycle test"));
  mkdirSync(join(root, "_site"));
  writeFileSync(join(root, "_site", "index.html"), "<!doctype html><title>ready</title>");
  return root;
}

async function waitForFileOrExit(
  path: string,
  child: ReturnType<typeof Bun.spawn>,
  output: Promise<{ stdout: string; stderr: string }>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (child.exitCode !== null) {
      const { stdout, stderr } = await output;
      throw new Error(
        `Server exited before readiness (code ${child.exitCode}).\n${stderr || stdout}`.trim(),
      );
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(25);
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("server lifecycle", () => {
  test("keeps shutdown drain inside the Compose termination budget", () => {
    expect(readShutdownDrainSeconds(undefined)).toBe(20);
    expect(readShutdownDrainSeconds("1")).toBe(1);
    expect(readShutdownDrainSeconds("26")).toBe(26);
    for (const invalid of ["0", "27", "300", "1.5", "nope"]) {
      expect(() => readShutdownDrainSeconds(invalid)).toThrow("integer from 1 to 26");
    }
  });

  test("Bun graceful listener stop waits for an active response", async () => {
    let markStarted!: () => void;
    let finishResponse!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pendingResponse = new Promise<void>((resolve) => { finishResponse = resolve; });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        markStarted();
        await pendingResponse;
        return new Response("done");
      },
    });
    const request = fetch(`http://127.0.0.1:${server.port}`);
    await started;
    let stopped = false;
    const stopping = server.stop(false).then(() => { stopped = true; });
    await Bun.sleep(10);
    expect(stopped).toBeFalse();

    finishResponse();
    expect(await (await request).text()).toBe("done");
    await stopping;
    expect(stopped).toBeTrue();
  });

  test("returns a JSON 503 for coordinator transport failures", async () => {
    const response = serverErrorResponse(new RuntimeCoordinatorUnavailableError());
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({
      error: "Runtime coordinator is temporarily unavailable",
    });
  });

  test("refuses to serve a project without a built index", async () => {
    const root = makeTemporaryProject();
    unlinkSync(join(root, "_site", "index.html"));
    await expect(startServer(root, 0, "127.0.0.1")).rejects.toThrow("Built site is missing");
  });

  test("does not announce startup when the listener cannot bind", async () => {
    const root = makeTemporaryProject();
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("occupied"),
    });
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { messages.push(args.map(String).join(" ")) };
    try {
      await expect(startServer(root, blocker.port!, "127.0.0.1")).rejects.toThrow();
    } finally {
      console.log = originalLog;
      blocker.stop(true);
    }
    expect(messages.join("\n")).not.toContain("Kiwi Mu 서버 시작");
  });

  test("exits promptly and cleanly on SIGTERM", async () => {
    const root = makeTemporaryProject();
    const readyFile = join(root, "server-ready");
    const probe = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("probe"),
    });
    const port = probe.port!;
    probe.stop(true);
    const serverModuleUrl = pathToFileURL(join(import.meta.dir, "server.ts")).href;
    const childCode = [
      `import { writeFileSync } from "node:fs";`,
      `import { startServer } from ${JSON.stringify(serverModuleUrl)};`,
      `await startServer(${JSON.stringify(root)}, ${port}, "127.0.0.1");`,
      `writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", childCode], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        KIWIMU_AUTH_TOKEN: "kiwimu-lifecycle-test-token",
        KIWIMU_COORDINATOR_URL: undefined,
        KIWIMU_COORDINATOR_NAMESPACE: undefined,
      },
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const output = Promise.all([stdout, stderr]).then(([capturedStdout, capturedStderr]) => ({
      stdout: capturedStdout,
      stderr: capturedStderr,
    }));

    try {
      await waitForFileOrExit(readyFile, child, output, 3_000);
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok" });
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ready" });
      child.kill("SIGTERM");
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(3_000).then(() => { throw new Error("Server did not exit within 3 seconds of SIGTERM"); }),
      ]);

      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }

    expect((await output).stderr).toBe("");
  }, 10_000);

  test("fails readiness, rejects new mutations, and drains an admitted request on SIGTERM", async () => {
    const root = makeTemporaryProject();
    const readyFile = join(root, "server-ready");
    const probe = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("probe"),
    });
    const port = probe.port!;
    probe.stop(true);
    const token = "kiwimu-lifecycle-drain-token";
    const serverModuleUrl = pathToFileURL(join(import.meta.dir, "server.ts")).href;
    const childCode = [
      `import { writeFileSync } from "node:fs";`,
      `import { startServer } from ${JSON.stringify(serverModuleUrl)};`,
      `await startServer(${JSON.stringify(root)}, ${port}, "127.0.0.1");`,
      `writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", childCode], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        KIWIMU_AUTH_TOKEN: token,
        KIWIMU_SHUTDOWN_DRAIN_SECONDS: "2",
        KIWIMU_COORDINATOR_URL: undefined,
        KIWIMU_COORDINATOR_NAMESPACE: undefined,
      },
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const output = Promise.all([stdout, stderr]).then(([capturedStdout, capturedStderr]) => ({
      stdout: capturedStdout,
      stderr: capturedStderr,
    }));

    let releaseBody!: () => void;
    const bodyRelease = new Promise<void>((resolve) => { releaseBody = resolve; });
    const boundary = "kiwimu-lifecycle-boundary";
    const encoder = new TextEncoder();
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="slow.md"\r\n` +
          "Content-Type: text/markdown\r\n\r\n",
        ));
        void bodyRelease.then(() => {
          controller.enqueue(encoder.encode(`# delayed upload\r\n--${boundary}--\r\n`));
          controller.close();
        });
      },
    });

    try {
      await waitForFileOrExit(readyFile, child, output, 3_000);
      const slowRequest = fetch(`http://127.0.0.1:${port}/api/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "X-Kiwimu-File-Extension": "md",
        },
        body: slowBody,
      });
      await Bun.sleep(100);
      child.kill("SIGTERM");

      let ready: Response | null = null;
      const readyDeadline = Date.now() + 1_000;
      while (Date.now() < readyDeadline) {
        try {
          ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
          if (ready.status === 503) break;
        } catch {
          // The active request keeps the listener open; retry transient races.
        }
        await Bun.sleep(10);
      }
      expect(ready?.status).toBe(503);
      expect(await ready!.json()).toEqual({ status: "not_ready" });
      // A repeated signal of the same kind must remain handled throughout the
      // drain rather than reverting to its default immediate-exit action.
      child.kill("SIGTERM");

      const rejected = await fetch(`http://127.0.0.1:${port}/api/build`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get("retry-after")).toBe("1");

      releaseBody();
      // This request entered fetch before the signal, but it must re-check
      // admission after its delayed body and avoid creating a content job.
      expect((await slowRequest).status).toBe(503);
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(3_000).then(() => { throw new Error("Server did not finish its drain within 3 seconds"); }),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      releaseBody();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }

    expect((await output).stderr).toBe("");
  }, 10_000);

  test("waits for every server instance when one idle server receives SIGTERM too", async () => {
    const activeRoot = makeTemporaryProject();
    const idleRoot = makeTemporaryProject();
    const readyFile = join(activeRoot, "servers-ready");
    const reservePort = () => {
      const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
      const selected = probe.port!;
      probe.stop(true);
      return selected;
    };
    const activePort = reservePort();
    const idlePort = reservePort();
    const token = "kiwimu-lifecycle-multi-server-token";
    const serverModuleUrl = pathToFileURL(join(import.meta.dir, "server.ts")).href;
    const childCode = [
      `import { writeFileSync } from "node:fs";`,
      `import { startServer } from ${JSON.stringify(serverModuleUrl)};`,
      `await startServer(${JSON.stringify(activeRoot)}, ${activePort}, "127.0.0.1");`,
      `await startServer(${JSON.stringify(idleRoot)}, ${idlePort}, "127.0.0.1");`,
      `writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", childCode], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        KIWIMU_AUTH_TOKEN: token,
        KIWIMU_SHUTDOWN_DRAIN_SECONDS: "2",
        KIWIMU_COORDINATOR_URL: undefined,
        KIWIMU_COORDINATOR_NAMESPACE: undefined,
      },
    });
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([stdout, stderr]) => ({ stdout, stderr }));

    let releaseBody!: () => void;
    const bodyRelease = new Promise<void>((resolve) => { releaseBody = resolve; });
    const boundary = "kiwimu-multi-server-boundary";
    const encoder = new TextEncoder();
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="slow.md"\r\n` +
          "Content-Type: text/markdown\r\n\r\n",
        ));
        void bodyRelease.then(() => {
          controller.enqueue(encoder.encode(`# delayed upload\r\n--${boundary}--\r\n`));
          controller.close();
        });
      },
    });

    try {
      await waitForFileOrExit(readyFile, child, output, 3_000);
      const slowRequest = fetch(`http://127.0.0.1:${activePort}/api/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "X-Kiwimu-File-Extension": "md",
        },
        body: slowBody,
      });
      await Bun.sleep(100);
      child.kill("SIGTERM");
      child.kill("SIGTERM");
      await Bun.sleep(150);
      expect(child.exitCode).toBeNull();

      releaseBody();
      expect((await slowRequest).status).toBe(503);
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(3_000).then(() => { throw new Error("All server instances did not finish draining"); }),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      releaseBody();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    expect((await output).stderr).toBe("");
  }, 10_000);
});
