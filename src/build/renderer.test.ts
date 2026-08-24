import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type KiwiConfig } from "../config";
import { Store } from "../store";
import { StaleContentFenceError } from "../repositories/content-fence-repository";
import { inlineScriptHashes } from "./csp";
import { publishStagedFigures } from "../services/ingest-staging";
import {
  buildSinglePage,
  buildSite,
  publishIngestGenerationWithSite,
  renderPageContent,
  resolveBuildOutputDir,
  writeFileAtomically,
} from "./renderer";

describe("Markdown rendering boundaries", () => {
  test("rewrites explicit wiki links only outside code and keeps piped labels", async () => {
    const html = await renderPageContent({
      content: [
        "Inline `[[target|inline example]]`",
        "",
        "````md",
        "```txt",
        "[[target|fenced example]]",
        "```",
        "````",
        "",
        "Plain [[target|display text]], [[target-page]], and [[missing-page|missing label]].",
      ].join("\n"),
    }, new Set(["target"]));

    expect(html).toContain("<code>[[target|inline example]]</code>");
    expect(html).toContain("[[target|fenced example]]");
    expect(html).toContain('<a href="/wiki/target.html">display text</a>');
    expect(html).toContain('<a href="/wiki/target-page.html" class="redlink" title="문서 없음: target-page">target page</a>');
    expect(html).toContain('href="/wiki/missing-page.html" class="redlink"');
    expect(html).toContain(">missing label</a>");
  });

  test("adds the HTML suffix before an internal link query or fragment", async () => {
    const html = await renderPageContent({
      content: "[fragment](/wiki/target#details) [query](/wiki/target?mode=1)",
    }, new Set(["target"]));

    expect(html).toContain('href="/wiki/target.html#details"');
    expect(html).toContain('href="/wiki/target.html?mode=1"');
    expect(html).not.toContain("redlink");
  });

  test("uses collision-resistant placeholders and protects Mermaid before math", async () => {
    const html = await renderPageContent({
      content: [
        "Literal %%MATH_INLINE_0%% and %%MERMAID_BLOCK_0%%.",
        "",
        "Inline math $x_1$.",
        "",
        "$$x^2 + y^2$$",
        "",
        "```mermaid",
        'flowchart LR',
        '  A["Cost $5$"] --> B',
        "```",
      ].join("\n"),
    });

    expect(html).toContain("%%MATH_INLINE_0%%");
    expect(html).toContain("%%MERMAID_BLOCK_0%%");
    expect(html).toContain("$x_1$");
    expect(html).toContain("$$x^2 + y^2$$");
    expect(html).toContain('A["Cost $5$"] --&gt; B');
    expect(html).not.toMatch(/KIWIMU[0-9a-f]+PLACEHOLDER/);
  });
});

function writeProjectConfig(root: string, outputDir = "_site"): void {
  writeFileSync(join(root, "kiwi.toml"), `
[project]
name = "Atomic Build Test"
created = "2026-07-15"

[build]
output_dir = "${outputDir}"

[llm]
provider = "demo"
model = ""
api_key = ""
endpoint = ""

[deploy]
target = "gh-pages"
`);
}

describe("atomic site publishing", () => {
  let root: string;
  let store: Store;
  let config: KiwiConfig;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kiwimu-build-"));
    store = new Store(join(root, "wiki.db"));
    config = defaultConfig("Atomic Build Test");
    config.build.output_dir = "_site";
    const source = store.addSource("file:///atomic.md", "markdown", "Atomic source", "raw");
    const page = store.addPage("atomic-page", "Atomic page", "# Atomic\n\nNew content", source.id);
    store.addCitation(page.id, source.id, page.id, "Atomic excerpt");
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("publishes a complete staged site and removes the old site and swap artifacts", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "old-release.txt"), "old release");

    expect(await buildSite(store, config, root)).toBe(1);

    expect(existsSync(join(outputDir, "old-release.txt"))).toBeFalse();
    expect(readFileSync(join(outputDir, "index.html"), "utf8")).toContain("Atomic Build Test");
    expect(readFileSync(join(outputDir, "wiki", "atomic-page.html"), "utf8")).toContain("New content");
    const provenance = readFileSync(join(outputDir, "provenance.html"), "utf8");
    expect(provenance).toContain("Atomic source");
    expect(provenance).toContain('href="/wiki/atomic-page.html"');
    expect(existsSync(join(outputDir, "static", "vendor", "katex", "katex.min.js"))).toBeTrue();
    expect(existsSync(join(outputDir, "static", "vendor", "katex", "katex.min.css"))).toBeFalse();
    expect(existsSync(join(outputDir, "static", "vendor", "katex", "fonts"))).toBeFalse();
    expect(existsSync(join(outputDir, "static", "vendor", "mermaid", "mermaid.min.js"))).toBeTrue();
    expect(existsSync(join(outputDir, "static", "mermaid-frame.htm"))).toBeTrue();
    expect(existsSync(join(outputDir, "static", "mermaid-frame.js"))).toBeTrue();
    for (const asset of ["navigation.js", "quiz.js", "dashboard.js", "admin.js", "catalog.js", "activity.js", "random-redirect.js"]) {
      expect(existsSync(join(outputDir, "static", asset))).toBeTrue();
    }
    expect(readdirSync(root).filter((name) => /\._site\.(?:staging|backup)-/.test(name))).toEqual([]);
  });

  test("emits robots.txt and skips sitemap.xml when no absolute site URL is resolvable", async () => {
    const outputDir = join(root, "_site");

    await buildSite(store, config, root);

    const robots = readFileSync(join(outputDir, "robots.txt"), "utf8");
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).not.toContain("Sitemap:");
    expect(existsSync(join(outputDir, "sitemap.xml"))).toBeFalse();

    const page = readFileSync(join(outputDir, "wiki", "atomic-page.html"), "utf8");
    expect(page).toContain('<meta property="og:image" content="/static/logo.png">');
    expect(page).toContain('<meta property="og:site_name" content="Atomic Build Test">');
    expect(page).not.toContain('rel="canonical"');
    expect(page).not.toContain('property="og:url"');
  });

  test("emits an absolute sitemap.xml and per-page canonical/OG tags when build.site_url is set", async () => {
    const outputDir = join(root, "_site");
    config.build.site_url = "https://example.com";

    await buildSite(store, config, root);

    const robots = readFileSync(join(outputDir, "robots.txt"), "utf8");
    expect(robots).toContain("Sitemap: https://example.com/sitemap.xml");

    const sitemap = readFileSync(join(outputDir, "sitemap.xml"), "utf8");
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap).toContain("<loc>https://example.com/index.html</loc>");
    expect(sitemap).toContain("<loc>https://example.com/wiki/atomic-page.html</loc>");

    const page = readFileSync(join(outputDir, "wiki", "atomic-page.html"), "utf8");
    expect(page).toContain('<link rel="canonical" href="https://example.com/wiki/atomic-page.html">');
    expect(page).toContain('<meta property="og:url" content="https://example.com/wiki/atomic-page.html">');
    expect(page).toContain('<meta property="og:image" content="https://example.com/static/logo.png">');
  });

  test("does not publish stale project figures when the database has no figure rows", async () => {
    mkdirSync(join(root, "figures"));
    writeFileSync(join(root, "figures", "stale.png"), "not referenced");

    await buildSite(store, config, root);

    expect(existsSync(join(root, "_site", "static", "figures", "stale.png"))).toBeFalse();
  });

  test("removes an unreferenced generation figure before building", async () => {
    const figuresDir = join(root, "figures");
    mkdirSync(figuresDir);
    const orphan = join(figuresDir, "src1-aaaaaaaaaaaa-1-1.png");
    writeFileSync(orphan, "abandoned generation", { mode: 0o600 });
    chmodSync(orphan, 0o600);
    const oldTimestamp = new Date(Date.now() - 5 * 60_000 - 1);
    utimesSync(orphan, oldTimestamp, oldTimestamp);
    writeFileSync(join(figuresDir, "operator.png"), "operator image");

    await buildSite(store, config, root);

    expect(existsSync(orphan)).toBeFalse();
    expect(existsSync(join(figuresDir, "operator.png"))).toBeTrue();
  });

  test("publishes only allowlisted regular figure files from the project figures directory", async () => {
    const figuresDir = join(root, "figures");
    mkdirSync(figuresDir);
    writeFileSync(join(figuresDir, "approved.png"), "approved figure");
    writeFileSync(join(figuresDir, "stale.png"), "stale figure");
    mkdirSync(join(figuresDir, "directory.png"));
    const outsideFigure = join(root, "outside.png");
    writeFileSync(outsideFigure, "outside figure");
    symlinkSync(outsideFigure, join(figuresDir, "linked.png"));

    const sourceId = store.listSourcesMeta()[0].id;
    store.addFigure(sourceId, "/static/figures/approved.png");
    store.addFigure(sourceId, "/static/figures/missing.png");
    store.addFigure(sourceId, "/static/figures/linked.png");
    store.addFigure(sourceId, "/static/figures/directory.png");
    store.addFigure(sourceId, "/static/figures/../outside.png");

    await buildSite(store, config, root);

    const publishedFigures = join(root, "_site", "static", "figures");
    expect(readFileSync(join(publishedFigures, "approved.png"), "utf8")).toBe("approved figure");
    for (const rejected of ["stale.png", "missing.png", "linked.png", "directory.png"]) {
      expect(existsSync(join(publishedFigures, rejected))).toBeFalse();
    }
    expect(existsSync(join(root, "_site", "static", "outside.png"))).toBeFalse();
  });

  test("keeps Markdown headings and missing wiki-link labels inside the sanitized HTML boundary", async () => {
    const headingPayload = "document.body.dataset.pwned='heading'";
    const linkPayload = "document.body.dataset.pwned='link'";
    store.addPage(
      "hostile-page",
      "Hostile page",
      `## Safe section\n\n## <script>${headingPayload}</script>\n\n[x](/wiki/%22%3E%3Cscript%3E${encodeURIComponent(linkPayload)}%3C/script%3E)`,
    );

    await buildSite(store, config, root);

    const html = readFileSync(join(root, "_site", "wiki", "hostile-page.html"), "utf8");
    const headingHash = inlineScriptHashes(`<script>${headingPayload}</script>`)[0];
    const linkHash = inlineScriptHashes(`<script>${linkPayload}</script>`)[0];

    expect(html).toContain('<h2 id="safe-section">Safe section</h2>');
    expect(html).toContain('<a href="#safe-section">Safe section</a>');
    expect(html).not.toContain(`<script>${headingPayload}</script>`);
    expect(html).not.toContain(`<script>${linkPayload}</script>`);
    expect(html).not.toContain(headingHash);
    expect(html).not.toContain(linkHash);
  });

  test("a final fencing failure preserves the old site and cleans staging", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "index.html"), "known-good-release");

    await expect(buildSite(store, config, root, {
      beforePublish: () => {
        throw new Error("injected lease loss");
      },
    })).rejects.toThrow("injected lease loss");

    expect(readFileSync(join(outputDir, "index.html"), "utf8")).toBe("known-good-release");
    expect(readdirSync(root).filter((name) => /\._site\.(?:staging|backup)-/.test(name))).toEqual([]);
  });

  test("a publish rename failure rolls the backup back immediately", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "index.html"), "rollback-release");

    await expect(buildSite(store, config, root, {
      beforePublish: () => {
        const stagingName = readdirSync(root).find((name) => name.startsWith("._site.staging-"));
        if (!stagingName) throw new Error("staging directory not found");
        rmSync(join(root, stagingName), { recursive: true });
      },
    })).rejects.toThrow("Failed to publish staged site");

    expect(readFileSync(join(outputDir, "index.html"), "utf8")).toBe("rollback-release");
    expect(readdirSync(root).filter((name) => /\._site\.(?:staging|backup)-/.test(name))).toEqual([]);
  });

  test("a stale owner cannot swap a completed staged site after its fence is replaced", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "index.html"), "old fenced release");
    const staleFence = store.activateContentFence({
      resource: "content-mutation",
      ownerToken: "old-owner",
      fencingToken: 1,
    });
    const replacementStore = new Store(join(root, "wiki.db"));

    try {
      await expect(store.runWithContentFence(staleFence, async () => {
        await buildSite(store, config, root, {
          beforePublish: () => {
            replacementStore.activateContentFence({
              resource: "content-mutation",
              ownerToken: "new-owner",
              fencingToken: 2,
            });
          },
        });
      })).rejects.toBeInstanceOf(StaleContentFenceError);

      expect(readFileSync(join(outputDir, "index.html"), "utf8")).toBe("old fenced release");
      expect(readdirSync(root).filter((name) => /\._site\.(?:staging|backup)-/.test(name))).toEqual([]);
    } finally {
      replacementStore.close();
    }
  });

  test("publishes a reconciled ingest generation and its candidate site together", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "index.html"), "old generation");
    const staging = new Store(":memory:");
    try {
      const draft = {
        uri: "file:///atomic.md",
        type: "markdown",
        title: "Replacement source",
        rawContent: "replacement raw",
      };
      const stagedSource = staging.seedIngestStaging(
        store.createIngestStagingSnapshot(draft.uri),
        draft,
      );
      staging.addPage(
        "atomic-page",
        "Replacement page",
        "# Replacement\n\nCandidate generation body",
        stagedSource.id,
        undefined,
        "source",
      );

      const result = await publishIngestGenerationWithSite(
        store,
        staging,
        stagedSource.id,
        draft,
        "a".repeat(64),
        config,
        root,
      );

      expect(result.pageCount).toBe(1);
      expect(store.getSource(draft.uri)).toMatchObject({
        title: "Replacement source",
        content_hash: "a".repeat(64),
      });
      expect(store.getPage("atomic-page")?.content).toContain("Candidate generation body");
      expect(readFileSync(join(outputDir, "wiki", "atomic-page.html"), "utf8"))
        .toContain("Candidate generation body");
      expect(readdirSync(root).filter((name) => name.includes(".candidate-") || name.includes(".backup-")))
        .toEqual([]);
    } finally {
      staging.close();
    }
  });

  test("overlays the exact staged figure generation into the candidate site", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "index.html"), "old generation");
    const staging = new Store(":memory:");
    const stagedFigures = join(root, "staged-figures");
    mkdirSync(stagedFigures, { mode: 0o700 });
    try {
      const draft = {
        uri: "file:///atomic.md",
        type: "pdf",
        title: "Figure replacement",
        rawContent: "replacement raw",
      };
      const stagedSource = staging.seedIngestStaging(
        store.createIngestStagingSnapshot(draft.uri),
        draft,
      );
      const page = staging.addPage(
        "atomic-page",
        "Figure replacement",
        "![Candidate](/static/figures/gen-aaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccccccc-1-1.png)",
        stagedSource.id,
        undefined,
        "source",
      );
      const filename = "gen-aaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccccccc-1-1.png";
      writeFileSync(join(stagedFigures, filename), "candidate image", { mode: 0o600 });
      staging.addFigure(stagedSource.id, `/static/figures/${filename}`, page.id);

      await publishIngestGenerationWithSite(
        store,
        staging,
        stagedSource.id,
        draft,
        "f".repeat(64),
        config,
        root,
        {
          stagedFigureDirectory: stagedFigures,
          publishFiles: () => publishStagedFigures(stagedFigures, join(root, "figures")),
        },
      );

      expect(readFileSync(join(outputDir, "static", "figures", filename), "utf8"))
        .toBe("candidate image");
      expect(readFileSync(join(root, "figures", filename), "utf8")).toBe("candidate image");
      expect(store.listFigurePaths()).toContain(`/static/figures/${filename}`);
    } finally {
      staging.close();
    }
  });

  test("an ingest candidate render failure preserves the previous DB and site", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "index.html"), "old generation");
    const staging = new Store(":memory:");
    try {
      const draft = {
        uri: "file:///atomic.md",
        type: "markdown",
        title: "Must not publish",
        rawContent: "replacement raw",
      };
      const stagedSource = staging.seedIngestStaging(
        store.createIngestStagingSnapshot(draft.uri),
        draft,
      );
      // SQLite permits NUL in text, while filesystem paths do not. This
      // injects a deterministic renderer write failure before live reconcile.
      staging.addPage("invalid\0slug", "Invalid path", "candidate", stagedSource.id, undefined, "source");

      await expect(publishIngestGenerationWithSite(
        store,
        staging,
        stagedSource.id,
        draft,
        "b".repeat(64),
        config,
        root,
      )).rejects.toThrow();

      expect(store.getSource(draft.uri)?.title).toBe("Atomic source");
      expect(store.getPage("atomic-page")?.content).toContain("New content");
      expect(readFileSync(join(outputDir, "index.html"), "utf8")).toBe("old generation");
      expect(readdirSync(root).filter((name) => /\._site\.(?:staging|backup|candidate)-/.test(name)))
        .toEqual([]);
    } finally {
      staging.close();
    }
  });

  test("an ingest directory rename failure rolls back both DB and site", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "index.html"), "old generation");
    const staging = new Store(":memory:");
    try {
      const draft = {
        uri: "file:///atomic.md",
        type: "markdown",
        title: "Must roll back",
        rawContent: "replacement raw",
      };
      const stagedSource = staging.seedIngestStaging(
        store.createIngestStagingSnapshot(draft.uri),
        draft,
      );
      staging.addPage("atomic-page", "Replacement", "new generation", stagedSource.id, undefined, "source");
      let renameCalls = 0;

      await expect(publishIngestGenerationWithSite(
        store,
        staging,
        stagedSource.id,
        draft,
        "c".repeat(64),
        config,
        root,
        {
          renameDirectory(from, to) {
            renameCalls++;
            if (renameCalls === 2) throw new Error("injected candidate directory rename failure");
            renameSync(from, to);
          },
        },
      )).rejects.toThrow("Failed to publish staged site");

      expect(store.getSource(draft.uri)?.title).toBe("Atomic source");
      expect(store.getPage("atomic-page")?.content).toContain("New content");
      expect(readFileSync(join(outputDir, "index.html"), "utf8")).toBe("old generation");
      expect(readdirSync(root).filter((name) => /\._site\.(?:staging|backup|candidate)-/.test(name)))
        .toEqual([]);
    } finally {
      staging.close();
    }
  });

  test("a post-swap DB failure compensates the site back to the previous generation", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "index.html"), "old generation");
    const staging = new Store(":memory:");
    try {
      const draft = {
        uri: "file:///atomic.md",
        type: "markdown",
        title: "Must roll back",
        rawContent: "replacement raw",
      };
      const stagedSource = staging.seedIngestStaging(
        store.createIngestStagingSnapshot(draft.uri),
        draft,
      );
      staging.addPage("atomic-page", "Replacement", "new generation", stagedSource.id, undefined, "source");

      await expect(publishIngestGenerationWithSite(
        store,
        staging,
        stagedSource.id,
        draft,
        "d".repeat(64),
        config,
        root,
        {
          afterDirectoryPublish() {
            throw new Error("injected DB commit failure after directory swap");
          },
        },
      )).rejects.toThrow("injected DB commit failure");

      expect(store.getSource(draft.uri)?.title).toBe("Atomic source");
      expect(store.getPage("atomic-page")?.content).toContain("New content");
      expect(readFileSync(join(outputDir, "index.html"), "utf8")).toBe("old generation");
      expect(readdirSync(root).filter((name) => /\._site\.(?:staging|backup|candidate)-/.test(name)))
        .toEqual([]);
    } finally {
      staging.close();
    }
  });

  test("a replacement fence rejects ingest DB and site publication together", async () => {
    const outputDir = join(root, "_site");
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, "index.html"), "old generation");
    const staging = new Store(":memory:");
    const staleFence = store.activateContentFence({
      resource: "content-mutation",
      ownerToken: "old-ingest-owner",
      fencingToken: 11,
    });
    const replacementStore = new Store(join(root, "wiki.db"));
    try {
      const draft = {
        uri: "file:///atomic.md",
        type: "markdown",
        title: "Stale replacement",
        rawContent: "replacement raw",
      };
      const stagedSource = staging.seedIngestStaging(
        store.createIngestStagingSnapshot(draft.uri),
        draft,
      );
      staging.addPage("atomic-page", "Replacement", "stale generation", stagedSource.id, undefined, "source");

      await expect(store.runWithContentFence(staleFence, async () => {
        await publishIngestGenerationWithSite(
          store,
          staging,
          stagedSource.id,
          draft,
          "e".repeat(64),
          config,
          root,
          {
            beforePublish() {
              replacementStore.activateContentFence({
                resource: "content-mutation",
                ownerToken: "replacement-ingest-owner",
                fencingToken: 12,
              });
            },
          },
        );
      })).rejects.toBeInstanceOf(StaleContentFenceError);

      expect(store.getSource(draft.uri)?.title).toBe("Atomic source");
      expect(store.getPage("atomic-page")?.content).toContain("New content");
      expect(readFileSync(join(outputDir, "index.html"), "utf8")).toBe("old generation");
      expect(readdirSync(root).filter((name) => /\._site\.(?:staging|backup|candidate)-/.test(name)))
        .toEqual([]);
    } finally {
      replacementStore.close();
      staging.close();
    }
  });

  test("rejects project root, outside paths, and symlinked path components", async () => {
    for (const unsafeOutput of [".", "/", "../outside"]) {
      config.build.output_dir = unsafeOutput;
      await expect(buildSite(store, config, root)).rejects.toThrow("Unsafe build.output_dir");
    }

    const outside = mkdtempSync(join(tmpdir(), "kiwimu-build-outside-"));
    try {
      symlinkSync(outside, join(root, "linked"), "dir");
      expect(() => resolveBuildOutputDir(root, "linked/site")).toThrow("symbolic link");
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("atomic single-page writes", () => {
  let root: string;
  let store: Store;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kiwimu-single-page-"));
    writeProjectConfig(root);
    store = new Store(join(root, "wiki.db"));
    store.addPage("single", "Single page", "Updated single-page body");
    mkdirSync(join(root, "_site", "wiki"), { recursive: true });
    writeFileSync(join(root, "_site", "wiki", "single.html"), "old page");
    writeFileSync(join(root, "_site", "search-index.json"), JSON.stringify([
      { slug: "single", title: "Old", preview: "old", type: "concept" },
    ]));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("buildSinglePage atomically replaces HTML and its search entry", async () => {
    let fencingChecks = 0;
    await buildSinglePage(root, store, "single", {
      beforePublish: () => {
        fencingChecks++;
      },
    });

    expect(fencingChecks).toBe(1);
    expect(readFileSync(join(root, "_site", "wiki", "single.html"), "utf8")).toContain(
      "Updated single-page body",
    );
    const searchIndex = JSON.parse(readFileSync(join(root, "_site", "search-index.json"), "utf8"));
    expect(searchIndex).toHaveLength(1);
    expect(searchIndex[0]).toMatchObject({ slug: "single", title: "Single page" });
    expect(readdirSync(join(root, "_site", "wiki")).some((name) => name.includes(".tmp-"))).toBeFalse();
    expect(readdirSync(join(root, "_site")).some((name) => name.includes(".tmp-"))).toBeFalse();
  });

  test("a fencing failure before paired publication preserves both existing files", async () => {
    const storedPage = store.getPage("single")!;
    await expect(buildSinglePage(root, store, "single", {
      candidate: {
        page: { ...storedPage, content: "Uncommitted candidate body" },
        citations: [],
      },
      commitCandidate: () => {
        store.updatePageContentAndCitationsBySlug("single", "Uncommitted candidate body", []);
      },
      beforePublish: () => {
        throw new Error("injected lease loss before paired publish");
      },
    })).rejects.toThrow("injected lease loss before paired publish");

    expect(store.getPage("single")?.content).toBe("Updated single-page body");
    expect(readFileSync(join(root, "_site", "wiki", "single.html"), "utf8")).toBe("old page");
    const preservedSearchIndex = JSON.parse(
      readFileSync(join(root, "_site", "search-index.json"), "utf8"),
    );
    expect(preservedSearchIndex[0].title).toBe("Old");
    expect(readdirSync(join(root, "_site", "wiki")).some((name) => name.includes(".tmp-"))).toBeFalse();
    expect(readdirSync(join(root, "_site")).some((name) => name.includes(".tmp-"))).toBeFalse();
  });

  test("a candidate DB mutation rolls back when staged file publication fails", async () => {
    const storedPage = store.getPage("single")!;
    const fence = store.activateContentFence({
      resource: "content-mutation",
      ownerToken: "candidate-owner",
      fencingToken: 1,
    });
    let renameCalls = 0;

    await expect(store.runWithContentFence(fence, async () => {
      await buildSinglePage(root, store, "single", {
        candidate: {
          page: { ...storedPage, content: "Candidate body" },
          citations: [],
        },
        commitCandidate: () => {
          store.updatePageContentAndCitationsBySlug("single", "Candidate body", []);
        },
        renameFile(from, to) {
          renameCalls++;
          if (renameCalls === 2) throw new Error("injected paired publication failure");
          renameSync(from, to);
        },
      });
    })).rejects.toThrow("injected paired publication failure");

    expect(store.getPage("single")?.content).toBe("Updated single-page body");
    expect(readFileSync(join(root, "_site", "wiki", "single.html"), "utf8")).toBe("old page");
    expect(JSON.parse(readFileSync(join(root, "_site", "search-index.json"), "utf8"))[0].title).toBe("Old");
  });

  test("a stale owner cannot publish either file after its fence is replaced", async () => {
    const storedPage = store.getPage("single")!;
    const staleFence = store.activateContentFence({
      resource: "content-mutation",
      ownerToken: "old-owner",
      fencingToken: 1,
    });
    const replacementStore = new Store(join(root, "wiki.db"));

    try {
      await expect(store.runWithContentFence(staleFence, async () => {
        await buildSinglePage(root, store, "single", {
          candidate: {
            page: { ...storedPage, content: "Stale candidate body" },
            citations: [],
          },
          commitCandidate: () => {
            store.updatePageContentAndCitationsBySlug("single", "Stale candidate body", []);
          },
          beforePublish: () => {
            replacementStore.activateContentFence({
              resource: "content-mutation",
              ownerToken: "new-owner",
              fencingToken: 2,
            });
          },
        });
      })).rejects.toBeInstanceOf(StaleContentFenceError);

      expect(store.getPage("single")?.content).toBe("Updated single-page body");
      expect(readFileSync(join(root, "_site", "wiki", "single.html"), "utf8")).toBe("old page");
      expect(JSON.parse(readFileSync(join(root, "_site", "search-index.json"), "utf8"))[0].title).toBe("Old");
    } finally {
      replacementStore.close();
    }
  });

  test("a second rename failure rolls the page back and preserves its search index", async () => {
    const searchIndexPath = join(root, "_site", "search-index.json");
    let renameCalls = 0;

    await expect(buildSinglePage(root, store, "single", {
      renameFile(from, to) {
        renameCalls++;
        if (renameCalls === 2) throw new Error("injected search-index rename failure");
        renameSync(from, to);
      },
    })).rejects.toThrow("injected search-index rename failure");

    expect(readFileSync(join(root, "_site", "wiki", "single.html"), "utf8")).toBe("old page");
    expect(JSON.parse(readFileSync(searchIndexPath, "utf8"))[0].title).toBe("Old");
    expect(readdirSync(join(root, "_site", "wiki")).some((name) => /\.(?:tmp|backup)-/.test(name))).toBeFalse();
    expect(readdirSync(join(root, "_site")).some((name) => /\.(?:tmp|backup)-/.test(name))).toBeFalse();
  });

  test("a rollback failure preserves the recovery backup", async () => {
    let renameCalls = 0;

    await expect(buildSinglePage(root, store, "single", {
      renameFile(from, to) {
        renameCalls++;
        if (renameCalls === 2 || renameCalls === 3) {
          throw new Error("injected publication and rollback failure");
        }
        renameSync(from, to);
      },
    })).rejects.toThrow("rollback also failed");

    const recoveryBackup = readdirSync(join(root, "_site", "wiki"))
      .find((name) => name.startsWith(".single.html.backup-"));
    expect(recoveryBackup).toBeDefined();
    expect(readFileSync(join(root, "_site", "wiki", recoveryBackup!), "utf8")).toBe("old page");
  });

  test("a rename failure preserves the previous file and removes its temporary file", () => {
    const target = join(root, "_site", "search-index.json");

    expect(() => writeFileAtomically(target, "new index", () => {
      throw new Error("injected rename failure");
    })).toThrow("injected rename failure");

    expect(JSON.parse(readFileSync(target, "utf8"))[0].title).toBe("Old");
    expect(readdirSync(join(root, "_site")).some((name) => name.includes(".tmp-"))).toBeFalse();
  });
});
