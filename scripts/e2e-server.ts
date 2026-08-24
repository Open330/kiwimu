import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultConfig, saveConfig } from "../src/config";
import { setupDemo } from "../src/demo/setup";
import { buildSite } from "../src/build/renderer";
import { prepareGhPagesSite } from "../src/deploy";
import { startServer } from "../src/server";
import { serveStaticRequest } from "../src/server/static";
import { Store } from "../src/store";

const root = mkdtempSync(join(tmpdir(), "kiwimu-e2e-"));
const cleanupActions: Array<() => void> = [
  () => rmSync(root, { recursive: true, force: true }),
];
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  for (const action of cleanupActions.reverse()) {
    try {
      action();
    } catch {
      // Process teardown is best-effort; the next action must still run.
    }
  }
};
process.once("exit", cleanup);

const config = defaultConfig("Kiwi Mu E2E");
config.llm.provider = "demo";
config.llm.model = "";
config.llm.api_key = "";
config.llm.endpoint = "";
saveConfig(root, config);

const store = new Store(join(root, "kiwi.db"));
try {
  store.initSchema();
  await setupDemo(store);
  store.addPage(
    "mermaid-e2e",
    "Mermaid CSP E2E",
    "```mermaid\ngraph TD\n  A[시작] --> B[완료]\n```",
  );
  store.addPage(
    "math-e2e",
    "MathML CSP E2E",
    String.raw`인라인 수식 $E = mc^2$와 블록 수식을 함께 검증합니다.

$$\int_0^1 x^2\,dx = \frac{1}{3}$$`,
  );
  await buildSite(store, config, root);
} finally {
  store.close();
}
const siteDir = join(root, config.build.output_dir);

// A second origin intentionally exposes only generated files. This catches
// accidental dependencies on authenticated/live API routes in static deploys.
const staticServer = Bun.serve({
  port: 8788,
  hostname: "127.0.0.1",
  fetch(request) {
    return serveStaticRequest({
      request,
      url: new URL(request.url),
      siteDir,
      isAuthenticated: () => false,
    });
  },
});
cleanupActions.push(() => staticServer.stop(true));

// Exercise the exact GitHub Pages deployment transform under a project-site
// prefix, rather than assuming root-mounted browser paths still work.
const pagesSite = prepareGhPagesSite(siteDir, "/kiwimu");
cleanupActions.push(pagesSite.cleanup);
const pagesServer = Bun.serve({
  port: 8789,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/kiwimu" && !url.pathname.startsWith("/kiwimu/")) {
      return new Response("Not Found", { status: 404 });
    }
    url.pathname = url.pathname.slice("/kiwimu".length) || "/";
    return serveStaticRequest({
      request,
      url,
      siteDir: pagesSite.siteDir,
      isAuthenticated: () => false,
    });
  },
});
cleanupActions.push(() => pagesServer.stop(true));

process.env.KIWIMU_AUTH_TOKEN = "kiwimu-e2e-auth-token";
await startServer(root, 8787, "127.0.0.1");

for (const url of [
  "http://127.0.0.1:8787/",
  "http://127.0.0.1:8788/",
  "http://127.0.0.1:8789/kiwimu/",
]) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`E2E origin failed readiness check: ${url} (${response.status})`);
}
console.log("KIWIMU_E2E_READY");
