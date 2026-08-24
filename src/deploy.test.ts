import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectContentSecurityPolicyMeta } from "./build/csp";
import {
  githubPagesBasePath,
  normalizeBasePath,
  parseGitHubRemote,
  prepareGhPagesSite,
  resolveGhPagesBasePath,
  rewriteRootReferences,
  withPreparedGhPagesSite,
} from "./deploy";

describe("GitHub Pages remote and base-path resolution", () => {
  test("parses HTTPS, SCP-like SSH, and ssh:// remotes", () => {
    expect(parseGitHubRemote("https://github.com/Open330/kiwimu.git")).toEqual({
      owner: "Open330",
      repo: "kiwimu",
    });
    expect(parseGitHubRemote("git@github.com:Open330/kiwimu.git")).toEqual({
      owner: "Open330",
      repo: "kiwimu",
    });
    expect(parseGitHubRemote("ssh://git@github.com/Open330/kiwimu.git")).toEqual({
      owner: "Open330",
      repo: "kiwimu",
    });
  });

  test("uses root for user sites and /repo for ordinary project sites", () => {
    expect(githubPagesBasePath("https://github.com/alice/alice.github.io.git")).toBe("/");
    expect(githubPagesBasePath("git@github.com:alice/study-wiki.git")).toBe("/study-wiki");
    expect(normalizeBasePath("/nested/docs/")).toBe("/nested/docs");
  });

  test("prefixes correctly when the repository name matches an application route", () => {
    const rewritten = rewriteRootReferences(
      `<a href="/wiki/topic.html"></a><script>fetch('/wiki/topic.html')</script>`,
      "/wiki",
    );
    expect(rewritten).toContain('href="/wiki/wiki/topic.html"');
    expect(rewritten).toContain("fetch('/wiki/wiki/topic.html')");
  });

  test("rejects ambiguous remotes and unsafe override paths", () => {
    expect(() => parseGitHubRemote("https://gitlab.com/alice/wiki.git")).toThrow("github.com");
    expect(() => parseGitHubRemote("not-a-remote")).toThrow("Unsupported GitHub remote URL");
    for (const path of ["", "../repo", "//evil", "/repo//child", "/repo?x=1", "/repo#x", "/repo%2fescape", "/repo\\child"]) {
      expect(() => normalizeBasePath(path)).toThrow();
    }
  });

  test("fails closed with an actionable override when origin cannot be inferred", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiwimu-no-origin-"));
    try {
      expect(() => resolveGhPagesBasePath({ projectRoot: directory })).toThrow("--base-path");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("GitHub Pages deployment rewriting", () => {
  let root: string;
  let source: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kiwimu-deploy-test-"));
    source = join(root, "_site");
    mkdirSync(join(source, "static"), { recursive: true });
    mkdirSync(join(source, "static", "vendor", "example"), { recursive: true });
    writeFileSync(join(source, "index.html"), `<!doctype html>
<html><head><link href="/static/style.css"><script src='/static/app.js'></script></head>
<body><a href="/wiki/topic.html">Topic</a><form action="/api/add"></form>
<a href="https://example.com/wiki/topic.html">External</a><img src="//cdn.example.com/logo.png">
<script>fetch('/search-index.json'); const closing = "</head>";</script></body></html>`);
    writeFileSync(join(source, "static", "app.js"), String.raw`
const WIKI_LINK_RE = /^\/wiki\/([^/?#]+)\.html$/;
fetch("/graph-data.json");
const card = '<a href="/wiki/' + slug + '.html">';
const external = "https://example.com/static/app.js";
const otherRegex = /\/api\/(.*)/;
const closingTag = "</script>";
const searchShortcut = event.key === "/";
location.href = '/';
`);
    writeFileSync(join(source, "static", "style.css"), `.hero{background:url(/static/logo.png)}\n.external{background:url(https://example.com/x.png)}`);
    writeFileSync(join(source, "static", "vendor", "example", "vendor.js"), `const operator = "/";`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("prefixes root paths without changing external URLs, unrelated regexes, or closing tags", () => {
    const input = readFileSync(join(source, "index.html"), "utf8") + readFileSync(join(source, "static", "app.js"), "utf8");
    const rewritten = rewriteRootReferences(input, "/kiwimu");

    expect(rewritten).toContain('href="/kiwimu/static/style.css"');
    expect(rewritten).toContain("src='/kiwimu/static/app.js'");
    expect(rewritten).toContain('href="/kiwimu/wiki/topic.html"');
    expect(rewritten).toContain("fetch('/kiwimu/search-index.json')");
    expect(rewritten).toContain(String.raw`/^\/kiwimu\/wiki\/`);
    expect(rewritten).toContain('href="/kiwimu/wiki/\' + slug');
    expect(rewritten).toContain("https://example.com/wiki/topic.html");
    expect(rewritten).toContain("//cdn.example.com/logo.png");
    expect(rewritten).toContain(String.raw`/\/api\/(.*)/`);
    expect(rewritten).toContain('"</head>"');
    expect(rewritten).toContain('"</script>"');
    expect(rewritten).toContain('event.key === "/"');
    expect(rewritten).toContain("location.href = '/kiwimu/'");
  });

  test("rewrites each project script URL without changing runtime storage scope detection", () => {
    const html = '<script src="/static/quiz.js"></script>';
    const runtime = "const scriptSuffix = '/' + 'static/quiz.js';";

    expect(rewriteRootReferences(html, "/kiwimu")).toContain('src="/kiwimu/static/quiz.js"');
    expect(rewriteRootReferences(html, "/other")).toContain('src="/other/static/quiz.js"');
    expect(rewriteRootReferences(runtime, "/kiwimu")).toBe(runtime);
    expect(rewriteRootReferences(runtime, "/other")).toBe(runtime);
  });

  test("prepares an isolated tree with .nojekyll and rewrites HTML, JS, and CSS", () => {
    const prepared = prepareGhPagesSite(source, "/kiwimu", root);
    try {
      expect(existsSync(join(prepared.siteDir, ".nojekyll"))).toBeTrue();
      expect(readFileSync(join(prepared.siteDir, "index.html"), "utf8")).toContain("/kiwimu/static/style.css");
      expect(readFileSync(join(prepared.siteDir, "static", "app.js"), "utf8")).toContain("/kiwimu/graph-data.json");
      expect(readFileSync(join(prepared.siteDir, "static", "style.css"), "utf8")).toContain("url(/kiwimu/static/logo.png)");
      expect(readFileSync(join(prepared.siteDir, "static", "vendor", "example", "vendor.js"), "utf8")).toBe(`const operator = "/";`);
      expect(readFileSync(join(source, "index.html"), "utf8")).not.toContain("/kiwimu/static/style.css");
    } finally {
      const stagingRoot = join(prepared.siteDir, "..");
      prepared.cleanup();
      expect(existsSync(stagingRoot)).toBeFalse();
    }
  });

  test("keeps root-site references unchanged while enforcing static CSP", () => {
    const original = readFileSync(join(source, "index.html"), "utf8");
    const prepared = prepareGhPagesSite(source, "/", root);
    try {
      expect(readFileSync(join(prepared.siteDir, "index.html"), "utf8"))
        .toBe(injectContentSecurityPolicyMeta(original));
      expect(existsSync(join(prepared.siteDir, ".nojekyll"))).toBeTrue();
    } finally {
      prepared.cleanup();
    }
  });

  test("keeps external scripts self-only after project-page rewriting", () => {
    const original = '<!doctype html><html><head></head><body><script src="/static/quiz.js"></script><script type="application/json" id="data">{"q":"\\u003c/script>"}</script></body></html>';
    writeFileSync(join(source, "csp.html"), original);
    const prepared = prepareGhPagesSite(source, "/kiwimu", root);
    try {
      const html = readFileSync(join(prepared.siteDir, "csp.html"), "utf8");
      expect(html).toContain('src="/kiwimu/static/quiz.js"');
      expect(html).toContain("script-src 'self'");
      expect(html).not.toContain("script-src 'self' 'sha256-");
    } finally {
      prepared.cleanup();
    }
  });

  test("always removes the temporary tree when publishing fails", async () => {
    let stagedSite = "";
    await expect(withPreparedGhPagesSite(source, "/kiwimu", (path) => {
      stagedSite = path;
      throw new Error("publish failed");
    }, root)).rejects.toThrow("publish failed");

    expect(stagedSite).not.toBe("");
    expect(existsSync(stagedSite)).toBeFalse();
    expect(readdirSync(root).filter((name) => name.startsWith("kiwimu-gh-pages-"))).toEqual([]);
  });
});
