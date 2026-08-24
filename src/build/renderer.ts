import {
  mkdirSync,
  rmSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  realpathSync,
  lstatSync,
  statSync,
} from "fs";
import { join, dirname, relative, resolve, isAbsolute, sep, basename, extname } from "path";
import { randomUUID } from "node:crypto";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { loadConfig, type KiwiConfig } from "../config";
import { Store, type Citation, type IngestSourceDraft, type Page, type Source } from "../store";
import { buildGraphData } from "../pipeline/graph";
import { renderCitationFootnotes } from "../pipeline/citations";
import {
  replaceWikiLinkMarkers,
  splitProtectedMarkdown,
  transformUnprotectedMarkdown,
} from "../pipeline/markdown-segments";
import { injectContentSecurityPolicyMeta } from "./csp";
import { cleanupOrphanedGenerationFigures } from "../services/figure-maintenance";
import { copyStagedFiguresForCandidate } from "../services/ingest-staging";
import {
  renderPage,
  renderIndex,
  renderGraph,
  renderQuizPage,
  renderDashboardPage,
  renderCatalogPage,
  renderProvenancePage,
  type SiteSeo,
} from "./templates";
import { readGitOriginUrl, githubPagesSiteUrl } from "../deploy";

interface VendorAssetSources {
  katexJs: string;
  mermaidJs: string;
  d3Js: string;
}

/** Escape a string for safe inclusion in XML content (sitemap <loc> URLs). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Resolve an absolute site base URL (origin + optional base path, no trailing
 * slash) for sitemap/canonical/OG tags. Priority: explicit `build.site_url`,
 * then the GitHub Pages URL inferred from the `origin` remote (like deploy.ts).
 * Returns `undefined` when neither is available so callers degrade gracefully.
 */
export function resolveSiteUrl(config: KiwiConfig, projectRoot: string): string | undefined {
  const configured = config.build?.site_url?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") || parsed.origin;
    } catch {
      // Fall through to git inference when site_url is malformed.
    }
  }
  try {
    return githubPagesSiteUrl(readGitOriginUrl(projectRoot));
  } catch {
    return undefined;
  }
}

async function writeGeneratedHtml(path: string, html: string): Promise<void> {
  await Bun.write(path, injectContentSecurityPolicyMeta(html));
}

const FIGURE_PUBLIC_PREFIX = "/static/figures/";
const PUBLISHABLE_FIGURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);

function copyPublishedFigures(store: Store, projectRoot: string, staticDir: string): void {
  const figurePaths = store.listFigurePaths();
  if (figurePaths.length === 0) return;

  const sourceRoot = resolve(projectRoot, "figures");
  try {
    const rootMetadata = lstatSync(sourceRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return;
  } catch {
    return;
  }

  const outputRoot = join(staticDir, "figures");
  for (const publicPath of figurePaths) {
    if (!publicPath.startsWith(FIGURE_PUBLIC_PREFIX)) continue;
    const pathWithinFigures = publicPath.slice(FIGURE_PUBLIC_PREFIX.length);
    const components = pathWithinFigures.split("/");
    if (
      components.length === 0 ||
      components.some((component) => !component || component === "." || component === ".." || component.includes("\\")) ||
      !PUBLISHABLE_FIGURE_EXTENSIONS.has(extname(pathWithinFigures).toLowerCase())
    ) continue;

    const sourcePath = resolve(sourceRoot, ...components);
    const relativeSource = relative(sourceRoot, sourcePath);
    if (
      relativeSource === "" ||
      relativeSource === ".." ||
      relativeSource.startsWith(`..${sep}`) ||
      isAbsolute(relativeSource)
    ) continue;

    let current = sourceRoot;
    let publishable = true;
    for (let index = 0; index < components.length; index++) {
      current = join(current, components[index]);
      try {
        const metadata = lstatSync(current);
        if (
          metadata.isSymbolicLink() ||
          (index === components.length - 1 ? !metadata.isFile() : !metadata.isDirectory())
        ) {
          publishable = false;
          break;
        }
      } catch {
        publishable = false;
        break;
      }
    }
    if (!publishable) continue;

    const targetPath = join(outputRoot, ...components);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

export interface BuildSiteOptions {
  /** Final lease/fencing assertion, run after validation and before publish. */
  beforePublish?: () => void | Promise<void>;
}

export interface PublishIngestSiteOptions extends BuildSiteOptions {
  /** Exact private figure generation to overlay into the rendered candidate. */
  stagedFigureDirectory?: string;
  /** Files associated with the staged generation, published inside the DB transaction. */
  publishFiles?: () => void;
  /** Injectable same-filesystem rename primitive for deterministic rollback tests. */
  renameDirectory?: RenameFile;
  /** Injectable post-swap failure point used to verify DB/site compensation. */
  afterDirectoryPublish?: () => void;
}

export interface BuildSinglePageOptions {
  /** Lease/fencing assertion run after both files are staged and before publication. */
  beforePublish?: () => void | Promise<void>;
  /** Uncommitted page/citations used to render and stage an atomic edit. */
  candidate?: { page: Page; citations: Citation[] };
  /** Synchronous DB mutation committed in the same fenced publication transaction. */
  commitCandidate?: () => void;
  /** Injectable final rename primitive for deterministic publication tests. */
  renameFile?: RenameFile;
}

/** Resolve and validate a build target before any directory is created or moved. */
export function resolveBuildOutputDir(projectRoot: string, configuredOutputDir: string): string {
  const canonicalRoot = realpathSync(resolve(projectRoot));
  const outputDir = resolve(canonicalRoot, configuredOutputDir);
  const relativeOutput = relative(canonicalRoot, outputDir);

  if (
    relativeOutput === "" ||
    relativeOutput === ".." ||
    relativeOutput.startsWith(`..${sep}`) ||
    isAbsolute(relativeOutput)
  ) {
    throw new Error(
      `Unsafe build.output_dir "${configuredOutputDir}": output must be a true child of project root "${canonicalRoot}".`
    );
  }

  // Do not allow an existing path component to redirect staging, backup, or
  // removal outside the canonical project root.
  let current = canonicalRoot;
  const components = relativeOutput.split(sep);
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Unsafe build.output_dir "${configuredOutputDir}": existing path component "${current}" is a symbolic link.`
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        `Unsafe build.output_dir "${configuredOutputDir}": existing path component "${current}" is not a directory.`
      );
    }
  }

  return outputDir;
}

type RenameFile = (from: string, to: string) => void;

interface AtomicWriteOptions {
  renameFile?: RenameFile;
  beforePublish?: () => void;
}

/** Write beside the target, then atomically replace it with a same-filesystem rename. */
export function writeFileAtomically(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions | RenameFile = {},
): void {
  const { renameFile = renameSync, beforePublish } = typeof options === "function"
    ? { renameFile: options, beforePublish: undefined }
    : options;
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx" });
    beforePublish?.();
    renameFile(tempPath, filePath);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

interface StagedFile {
  targetPath: string;
  temporaryPath: string;
  backupPath?: string;
}

function stagedPath(filePath: string, kind: "tmp" | "backup"): string {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${kind}-${process.pid}-${randomUUID()}`,
  );
}

function stageFileForPublication(filePath: string, contents: string): StagedFile {
  const temporaryPath = stagedPath(filePath, "tmp");
  writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
  return { targetPath: filePath, temporaryPath };
}

function removeIfPresent(path: string | undefined): void {
  if (path && existsSync(path)) rmSync(path, { force: true });
}

/**
 * Publish a small related set with rollback for ordinary rename failures.
 * Each replacement is individually atomic; the backup lets us restore already
 * replaced files if a later rename does not complete.
 */
function publishStagedFiles(
  files: StagedFile[],
  renameFile: RenameFile = renameSync,
): void {
  const published: StagedFile[] = [];
  let preserveBackups = false;
  try {
    for (const file of files) {
      if (existsSync(file.targetPath)) {
        file.backupPath = stagedPath(file.targetPath, "backup");
        copyFileSync(file.targetPath, file.backupPath, 0);
      }
      renameFile(file.temporaryPath, file.targetPath);
      published.push(file);
    }
  } catch (publishError) {
    const rollbackErrors: unknown[] = [];
    for (const file of published.toReversed()) {
      try {
        if (file.backupPath) {
          renameFile(file.backupPath, file.targetPath);
          file.backupPath = undefined;
        } else {
          rmSync(file.targetPath, { force: true });
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      preserveBackups = true;
      throw new AggregateError(
        [publishError, ...rollbackErrors],
        "Failed to publish staged files and rollback also failed. Recovery backups were preserved beside their targets.",
      );
    }
    throw publishError;
  } finally {
    for (const file of files) {
      removeIfPresent(file.temporaryPath);
      if (!preserveBackups) removeIfPresent(file.backupPath);
    }
  }
}

function assertNonEmptyFile(path: string): void {
  let metadata;
  try {
    metadata = statSync(path);
  } catch {
    throw new Error(`Staged site validation failed: required file is missing: ${path}`);
  }
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Staged site validation failed: required file is empty or invalid: ${path}`);
  }
}

function assertDirectory(path: string): void {
  let metadata;
  try {
    metadata = statSync(path);
  } catch {
    throw new Error(`Staged site validation failed: required directory is missing: ${path}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Staged site validation failed: required directory is invalid: ${path}`);
  }
}

function validateStagedSite(stagingDir: string): void {
  const vendorDir = join(stagingDir, "static", "vendor");
  assertDirectory(join(stagingDir, "static"));
  assertDirectory(vendorDir);
  for (const requiredPath of [
    "index.html",
    "provenance.html",
    "static/vendor/katex/katex.min.js",
    "static/vendor/mermaid/mermaid.min.js",
    "static/vendor/d3/d3.min.js",
    "static/mermaid-frame.htm",
    "static/mermaid-frame.js",
  ]) {
    assertNonEmptyFile(join(stagingDir, requiredPath));
  }
}

interface StagedSitePublication {
  publish(): void;
  rollback(): void;
  complete(): void;
}

/**
 * Keep the previous directory until the surrounding SQLite transaction has
 * committed. This lets an ordinary DB/fencing failure after the directory
 * swap compensate back to the last matched DB/site generation.
 */
function stagedSitePublication(
  stagingDir: string,
  outputDir: string,
  backupDir: string,
  renameDirectory: RenameFile = renameSync,
): StagedSitePublication {
  let previousSiteMoved = false;
  let candidatePublished = false;

  return {
    publish(): void {
      if (existsSync(outputDir)) {
        renameDirectory(outputDir, backupDir);
        previousSiteMoved = true;
      }

      try {
        renameDirectory(stagingDir, outputDir);
        candidatePublished = true;
      } catch (publishError) {
        if (previousSiteMoved) {
          try {
            renameDirectory(backupDir, outputDir);
            previousSiteMoved = false;
          } catch (rollbackError) {
            throw new AggregateError(
              [publishError, rollbackError],
              `Failed to publish staged site "${stagingDir}" and rollback also failed. Previous site is preserved at "${backupDir}".`,
            );
          }
        }
        throw new Error(`Failed to publish staged site "${stagingDir}" to "${outputDir}".`, { cause: publishError });
      }
    },

    rollback(): void {
      if (!candidatePublished) return;
      const rollbackErrors: unknown[] = [];
      try {
        renameDirectory(outputDir, stagingDir);
        candidatePublished = false;
      } catch (error) {
        rollbackErrors.push(error);
      }
      if (previousSiteMoved && !candidatePublished) {
        try {
          renameDirectory(backupDir, outputDir);
          previousSiteMoved = false;
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          rollbackErrors,
          `Failed to roll back published site. Recovery backup is preserved at "${backupDir}".`,
        );
      }
    },

    complete(): void {
      candidatePublished = false;
      if (!previousSiteMoved || !existsSync(backupDir)) return;
      try {
        rmSync(backupDir, { recursive: true });
        previousSiteMoved = false;
      } catch (cleanupError) {
        // DB and site already match. Preserve the obsolete backup and surface
        // its exact path without undoing a successful publication.
        console.warn(`Published site, but could not remove backup "${backupDir}":`, cleanupError);
      }
    },
  };
}

function publishStagedSite(stagingDir: string, outputDir: string, backupDir: string): void {
  const publication = stagedSitePublication(stagingDir, outputDir, backupDir);
  publication.publish();
  publication.complete();
}

function resolvePackageRoot(packageName: string): string {
  let entry: string;
  try {
    entry = Bun.resolveSync(packageName, dirname(import.meta.path));
  } catch {
    throw new Error(
      `Required browser runtime dependency "${packageName}" is missing. Run "bun install" before building the site.`
    );
  }

  let current = dirname(entry);
  while (true) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
        if (manifest.name === packageName) return current;
      } catch {
        // Keep walking: an unrelated or malformed ancestor manifest is not the
        // dependency root we are looking for.
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Unable to locate the installed package root for browser runtime dependency "${packageName}".`);
}

function requiredVendorFile(packageRoot: string, relativePath: string, packageName: string): string {
  const path = join(packageRoot, relativePath);
  if (!existsSync(path)) {
    throw new Error(
      `Browser runtime dependency "${packageName}" is incompatible: required asset "${relativePath}" was not found.`
    );
  }
  return path;
}

function resolveVendorAssetSources(): VendorAssetSources {
  const katexRoot = resolvePackageRoot("katex");
  const mermaidRoot = resolvePackageRoot("mermaid");
  const d3Root = resolvePackageRoot("d3");

  return {
    katexJs: requiredVendorFile(katexRoot, "dist/katex.min.js", "katex"),
    mermaidJs: requiredVendorFile(mermaidRoot, "dist/mermaid.min.js", "mermaid"),
    d3Js: requiredVendorFile(d3Root, "dist/d3.min.js", "d3"),
  };
}

function copyVendorAssets(staticDir: string, sources: VendorAssetSources): void {
  const vendorDir = join(staticDir, "vendor");
  const katexDir = join(vendorDir, "katex");
  const mermaidDir = join(vendorDir, "mermaid");
  const d3Dir = join(vendorDir, "d3");
  mkdirSync(katexDir, { recursive: true });
  mkdirSync(mermaidDir, { recursive: true });
  mkdirSync(d3Dir, { recursive: true });

  // MathML uses the browser's native layout and system math fonts. KaTeX's
  // HTML-only stylesheet/font bundle would be unused and can override that
  // layout, so ship only the parser runtime.
  cpSync(sources.katexJs, join(katexDir, "katex.min.js"));

  // Mermaid's standalone UMD bundle is intentionally used instead of its ESM
  // entry, whose lazy diagram imports require a multi-megabyte chunk tree.
  cpSync(sources.mermaidJs, join(mermaidDir, "mermaid.min.js"));
  cpSync(sources.d3Js, join(d3Dir, "d3.min.js"));
}

type SourcePageLink = Pick<Page, "slug" | "title" | "origin"> & {
  sourceUri: string | undefined;
};

function toSourcePageLink(
  page: Pick<Page, "slug" | "title" | "source_id" | "origin">,
  sourceUris: ReadonlyMap<number, string>
): SourcePageLink {
  return {
    slug: page.slug,
    title: page.title,
    sourceUri: page.source_id === null ? undefined : sourceUris.get(page.source_id),
    origin: page.origin,
  };
}

function escapeHtmlChars(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(s: string): string {
  return escapeHtmlChars(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Fallback: catches any ```mermaid block that slipped past the placeholder pre-pass.
// Keeps marked's existing escaping intact — the browser decodes via textContent
// when mermaid.js reads the diagram source.
function convertMermaidBlocks(html: string): string {
  if (!html.includes('language-mermaid')) return html;
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_match, code: string) => {
      if (!code.trim()) return '';
      return `<pre class="mermaid">${code}</pre>`;
    }
  );
}

// Fix internal wiki links: /wiki/slug → /wiki/slug.html
// Mark non-existent pages as "red links" (wiki convention for missing pages)
function fixWikiLinks(html: string, existingSlugs?: Set<string>): string {
  return html.replace(/href="\/wiki\/([^"]+?)"/g, (_match, target: string) => {
    const suffixIndex = target.search(/[?#]/);
    const path = suffixIndex === -1 ? target : target.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? "" : target.slice(suffixIndex);
    const hasHtmlSuffix = path.endsWith(".html");
    const cleanSlug = hasHtmlSuffix ? path.slice(0, -".html".length) : path;
    let decodedSlug: string;
    try {
      decodedSlug = decodeURIComponent(cleanSlug);
    } catch {
      decodedSlug = cleanSlug;
    }
    const href = `href="/wiki/${hasHtmlSuffix ? path : `${path}.html`}${suffix}"`;

    // If we have slug list and this page doesn't exist, mark as red link
    if (existingSlugs && !existingSlugs.has(decodedSlug) && !existingSlugs.has(cleanSlug)) {
      return `${href} class="redlink" title="문서 없음: ${escapeHtmlAttribute(decodedSlug)}"`;
    }
    return href;
  });
}

function mermaidBodyFromFence(markdown: string): string | null {
  const opener = markdown.match(/^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*(?:\r?\n)/i);
  if (!opener) return null;
  const marker = opener[1];
  const closingPattern = new RegExp(
    `^ {0,3}${marker[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}{${marker.length},}[ \\t]*(?:\\r?$)`,
    "gm",
  );
  closingPattern.lastIndex = opener[0].length;
  const closing = closingPattern.exec(markdown);
  if (!closing) return null;
  return markdown.slice(opener[0].length, closing.index);
}

// Separate external reference links from body content
function extractExternalRefs(html: string): { body: string; externalRefs: string } {
  const marker = '<h2 id="external-references">External References</h2>';
  const idx = html.indexOf(marker);
  if (idx === -1) return { body: html, externalRefs: "" };

  const body = html.slice(0, idx);
  const refSection = html.slice(idx + marker.length);
  return { body, externalRefs: refSection };
}

function decorateHeadingsAndGenerateToc(html: string): { html: string; toc: string } {
  const headings: Array<{ level: number; textHtml: string; id: string }> = [];
  const usedIds = new Map<string, number>();

  const decoratedHtml = html.replace(
    /<h([2-4])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (_match, rawLevel: string, rawAttributes: string, innerHtml: string) => {
      const level = Number(rawLevel);
      const textHtml = sanitizeHtml(innerHtml, { allowedTags: [], allowedAttributes: {} }).trim();
      const plainSlug = textHtml
        .replace(/&(?:#\d+|#x[\da-f]+|[a-z][\w-]*);/gi, " ")
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80);
      const baseId = plainSlug || `section-${headings.length + 1}`;
      const occurrence = (usedIds.get(baseId) || 0) + 1;
      usedIds.set(baseId, occurrence);
      const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
      const attributes = rawAttributes.replace(
        /\s+id=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
        "",
      );

      if (textHtml !== "External References") {
        headings.push({ level, textHtml, id });
      }
      return `<h${level}${attributes} id="${escapeHtmlAttribute(id)}">${innerHtml}</h${level}>`;
    },
  );

  const toc = headings.length
    ? `<div class="toc"><ul>${headings
      .map((heading) => `<li class="toc-level-${heading.level}"><a href="#${escapeHtmlAttribute(heading.id)}">${heading.textHtml}</a></li>`)
      .join("")}</ul></div>`
    : "";

  return { html: decoratedHtml, toc };
}

// Shared markdown rendering + sanitization logic
export async function renderPageContent(page: { content: string }, existingSlugs?: Set<string>): Promise<string> {
  const placeholderNamespace = `KIWIMU${randomUUID().replaceAll("-", "")}PLACEHOLDER`;
  const mermaidPlaceholders = new Map<string, string>();
  let mermaidIndex = 0;

  // Extract Mermaid before any other transform. Diagram labels may contain
  // dollar signs, wiki-link examples, or other Markdown-looking syntax.
  let markdown = splitProtectedMarkdown(page.content)
    .map((segment) => {
      if (!segment.protected) return segment.text;
      const body = mermaidBodyFromFence(segment.text);
      if (body === null) return segment.text;
      const placeholder = `${placeholderNamespace}MERMAID${mermaidIndex++}END`;
      mermaidPlaceholders.set(placeholder, body);
      return `\n\n${placeholder}\n\n`;
    })
    .join("");

  // Convert explicit wiki links only in ordinary Markdown text.
  markdown = replaceWikiLinkMarkers(markdown, ({ slug, display }) => {
    const text = display ?? slug.replace(/-/g, " ");
    return `[${text}](/wiki/${encodeURIComponent(slug)}.html)`;
  });

  // Protect LaTeX math from marked() processing
  // Replace $...$ and $$...$$ with placeholders to prevent _ and * from being parsed as markdown
  const mathPlaceholders = new Map<string, string>();
  let mathIndex = 0;
  markdown = transformUnprotectedMarkdown(markdown, (text) => {
    let transformed = text.replace(/\$\$[\s\S]+?\$\$/g, (match) => {
      const placeholder = `${placeholderNamespace}MATH${mathIndex++}END`;
      mathPlaceholders.set(placeholder, match);
      return placeholder;
    });
    // Inline delimiters may not hug whitespace. Besides matching common TeX
    // conventions, this leaves ordinary currency such as "$5 and $10" alone.
    transformed = transformed.replace(/(?<!\\)\$(?!\$|\s)([^\r\n]*?\S)(?<!\\)\$/g, (match) => {
      const placeholder = `${placeholderNamespace}MATH${mathIndex++}END`;
      mathPlaceholders.set(placeholder, match);
      return placeholder;
    });
    return transformed;
  });

  let htmlContent = await marked(markdown);

  // Restore LaTeX math from placeholders
  for (const [placeholder, literal] of mathPlaceholders) {
    // Use a replacer function so display delimiters (`$$`) are inserted
    // literally instead of being interpreted as replacement-string tokens.
    htmlContent = htmlContent.replaceAll(placeholder, () => literal);
  }
  // Fallback: convert any leftover marked-emitted mermaid code blocks
  htmlContent = convertMermaidBlocks(htmlContent);
  // Rewrite internal links before the sanitizer. This keeps every generated
  // attribute inside the same trust boundary as the Markdown-derived HTML.
  htmlContent = fixWikiLinks(htmlContent, existingSlugs);

  htmlContent = sanitizeHtml(htmlContent, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'details', 'summary', 'kbd', 'del', 's', 'sup', 'sub',
      'span', 'div', 'section', 'figure', 'figcaption', 'mark',
      'pre', 'code'
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      '*': ['id', 'class'],
      'img': ['src', 'alt', 'title', 'width', 'height'],
      'a': ['href', 'title', 'target', 'rel'],
      'span': ['class'],  // For KaTeX
      'pre': ['class'],   // For Mermaid
      'code': ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  });

  // Restore mermaid blocks AFTER sanitize so the diagram source is preserved
  // verbatim. Escape only the HTML structural chars so the browser's textContent
  // (which mermaid.js uses) yields the original characters.
  for (const [placeholder, body] of mermaidPlaceholders) {
    const rendered = body.trim() ? `<pre class="mermaid">${escapeHtmlChars(body)}</pre>` : "";
    htmlContent = htmlContent.replace(
      new RegExp(`(?:<p>\\s*)?${placeholder}(?:\\s*<\\/p>)?`, "g"),
      rendered,
    );
  }

  return htmlContent;
}

async function renderSiteToDirectory(
  store: Store,
  config: KiwiConfig,
  projectRoot: string,
  outputDir: string,
  vendorAssetSources: VendorAssetSources,
): Promise<number> {
  const wikiDir = join(outputDir, "wiki");
  const staticDir = join(outputDir, "static");

  mkdirSync(wikiDir, { recursive: true });
  mkdirSync(staticDir, { recursive: true });

  const assetsDir = join(dirname(import.meta.path), "static");
  if (existsSync(assetsDir)) {
    cpSync(assetsDir, staticDir, { recursive: true });
  }
  copyVendorAssets(staticDir, vendorAssetSources);

  // Publish only regular image files referenced by current DB rows. The
  // project figures directory can contain stale or operator-local files that
  // must not become public merely because a build ran.
  copyPublishedFigures(store, projectRoot, staticDir);

  // Copy logo (check multiple possible locations).
  // Order: shipped-with-kiwimu (works for both git clone and npm install), then
  // wiki-project-local overrides, then Docker path, then the assetsDir copy
  // already produced above (so Bun.file lookups stay consistent).
  const kiwimuAssets = join(dirname(import.meta.path), "..", "..", "assets", "logos", "logo_2_minimalist_icon_transparent.png");
  const logoCandidates = [
    kiwimuAssets,
    join(projectRoot, "..", "assets", "logos", "logo_2_minimalist_icon_transparent.png"),
    join(projectRoot, "assets", "logos", "logo_2_minimalist_icon_transparent.png"),
    "/app/assets/logos/logo_2_minimalist_icon_transparent.png", // Docker path
    join(staticDir, "logo.png"), // already copied via assetsDir → use it as the source
  ];
  const logoFile = logoCandidates.find(p => existsSync(p)) || null;
  if (logoFile && logoFile !== join(staticDir, "logo.png")) {
    cpSync(logoFile, join(staticDir, "logo.png"));
  }

  // Browsers fetch /favicon.ico from the site root regardless of HTML markup,
  // so we mirror it from the bundled static assets if present.
  const faviconSrc = join(staticDir, "favicon.ico");
  if (existsSync(faviconSrc)) {
    cpSync(faviconSrc, join(outputDir, "favicon.ico"));
  } else if (logoFile) {
    // Fall back to the logo as a favicon so /favicon.ico never 404s.
    cpSync(logoFile, join(outputDir, "favicon.ico"));
  }

  const pages = store.listPages();
  const sourcePages = store.listSourcePages();
  const conceptPages = store.listConceptPages();
  const wikiName = config.project.name;
  const backlinksMap = store.getAllBacklinksGrouped();
  const allSlugs = new Set(pages.map(p => p.slug));
  const categories = config.categories;
  const siteUrl = resolveSiteUrl(config, projectRoot);
  const siteSeo: SiteSeo = { siteUrl, lang: config.build?.lang };

  // Build source_id → uri map so PageLink rows can carry sourceUri (used by templates for category grouping)
  const sourceUriMap = new Map<number, string>();
  for (const s of store.listSources()) sourceUriMap.set(s.id, s.uri);
  const sourcePageLinks = sourcePages.map((page) => toSourcePageLink(page, sourceUriMap));
  const conceptPageLinks = conceptPages.map(({ slug, title }) => ({ slug, title }));
  const conceptPageLinksWithOrigin = conceptPages.map(({ slug, title, origin }) => ({ slug, title, origin }));

  for (const page of pages) {
    const renderedContent = await renderPageContent(page, allSlugs);
    const { html: htmlContent, toc } = decorateHeadingsAndGenerateToc(renderedContent);

    const { body, externalRefs } = extractExternalRefs(htmlContent);
    const firstFigure = htmlContent.match(new RegExp(`<img[^>]+src="(${FIGURE_PUBLIC_PREFIX}[^"]+)"`, "i"));
    const backlinks = (backlinksMap.get(page.id) || []).map((bl) => ({
      slug: bl.slug,
      title: bl.title,
      pageType: bl.page_type,
    }));

    // Citations footer
    const citations = store.getCitationsForPage(page.id);
    const citationsHtml = renderCitationFootnotes(citations);

    const html = renderPage({
      wikiName,
      pageTitle: page.title,
      pageSlug: page.slug,
      pageType: page.page_type,
      pageId: page.id,
      origin: page.origin,
      content: body,
      externalRefs,
      toc,
      backlinks,
      citationsHtml,
      sourcePages: sourcePageLinks,
      conceptPages: conceptPageLinksWithOrigin,
      categories,
      seo: siteSeo,
      ogImage: firstFigure?.[1],
    });

    await writeGeneratedHtml(join(wikiDir, `${page.slug}.html`), html);
  }

  const indexHtml = renderIndex({
    wikiName,
    sourcePages: sourcePageLinks,
    conceptPages: conceptPageLinks,
    sourceCount: store.countSources(),
    categories,
    seo: siteSeo,
  });
  await writeGeneratedHtml(join(outputDir, "index.html"), indexHtml);

  const graphData = buildGraphData(store);
  await Bun.write(join(outputDir, "graph-data.json"), JSON.stringify(graphData));
  await writeGeneratedHtml(
    join(outputDir, "graph.html"),
    renderGraph({
      wikiName,
      sourcePages: sourcePageLinks,
      conceptPages: conceptPageLinks,
      categories,
      seo: siteSeo,
    })
  );

  // Quiz page
  const quizzes = store.getAllQuizzes();
  await writeGeneratedHtml(
    join(outputDir, "quiz.html"),
    renderQuizPage({
      wikiName,
      quizzes: quizzes.map((q) => ({
        id: q.id,
        question: q.question,
        answer: q.answer,
        explanation: q.explanation || "",
        quiz_type: q.quiz_type,
        page_title: q.page_title,
        page_slug: q.page_slug,
      })),
      sourcePages: sourcePageLinks,
      conceptPages: conceptPageLinks,
      categories,
      seo: siteSeo,
    })
  );

  // Dashboard page
  const stats = store.getLearningStats();
  const weakConcepts = store.getWeakConcepts(10);
  const recentAttempts = store.getQuizHistory(20);
  await writeGeneratedHtml(
    join(outputDir, "dashboard.html"),
    renderDashboardPage({
      wikiName,
      stats,
      weakConcepts,
      recentAttempts,
      sourcePages: sourcePageLinks,
      conceptPages: conceptPageLinks,
      categories,
      seo: siteSeo,
    })
  );

  // Catalog (index) page
  const { generateContentIndex } = await import("../services/index-generator");
  const contentIndex = await generateContentIndex(store);
  await writeGeneratedHtml(
    join(outputDir, "catalog.html"),
    renderCatalogPage({
      wikiName,
      categories: contentIndex.categories,
      totalPages: contentIndex.totalPages,
      totalLinks: contentIndex.totalLinks,
      generatedAt: contentIndex.generatedAt,
      sourcePages: sourcePageLinks,
      conceptPages: conceptPageLinks,
      seo: siteSeo,
    })
  );

  // Static deployments need the same citation/source matrix as the live
  // /provenance route; otherwise their navigation leads to a server-only page.
  const provenanceMatrix = store.getSourceCoverage().map((coverage) => {
    const pageMap = new Map<number, { title: string; slug: string }>();
    for (const citation of store.getCitationsForSource(coverage.sourceId)) {
      if (citation.page_title && citation.page_slug && !pageMap.has(citation.page_id)) {
        pageMap.set(citation.page_id, { title: citation.page_title, slug: citation.page_slug });
      }
    }
    return {
      sourceId: coverage.sourceId,
      sourceTitle: coverage.sourceTitle,
      citationCount: coverage.citationCount,
      pageCount: coverage.pageCount,
      pages: [...pageMap.values()],
    };
  });
  await writeGeneratedHtml(
    join(outputDir, "provenance.html"),
    renderProvenancePage({
      wikiName,
      coverage: provenanceMatrix,
      sourcePages: sourcePageLinks,
      conceptPages: conceptPageLinks,
      categories,
      seo: siteSeo,
    }),
  );

  // Random page redirect
  mkdirSync(join(wikiDir), { recursive: true });
  await writeGeneratedHtml(
    join(wikiDir, "random.html"),
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>임의 문서</title></head><body><script src="/static/random-redirect.js"></script></body></html>`
  );

  const searchData = pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    preview: p.content.slice(0, 200),
    type: p.page_type,
  }));
  await Bun.write(join(outputDir, "search-index.json"), JSON.stringify(searchData));

  // SEO: robots.txt is always emitted; sitemap.xml only when an absolute base URL resolves.
  const robotsLines = ["User-agent: *", "Allow: /"];
  if (siteUrl) robotsLines.push(`Sitemap: ${siteUrl}/sitemap.xml`);
  await Bun.write(join(outputDir, "robots.txt"), `${robotsLines.join("\n")}\n`);

  if (siteUrl) {
    const routes = ["/index.html", ...pages.map((p) => `/wiki/${p.slug}.html`)];
    const urlEntries = routes
      .map((route) => `  <url><loc>${escapeXml(`${siteUrl}${route}`)}</loc></url>`)
      .join("\n");
    await Bun.write(
      join(outputDir, "sitemap.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>\n`,
    );
  } else {
    console.warn(
      'Skipping sitemap.xml: no absolute site URL. Set build.site_url in kiwi.toml (e.g. "https://user.github.io/repo") or configure a github.com origin remote to enable it.',
    );
  }

  return pages.length;
}

export async function buildSite(
  store: Store,
  config: KiwiConfig,
  projectRoot: string,
  options: BuildSiteOptions = {},
): Promise<number> {
  // Resolve all dependencies and dangerous paths before creating staging or
  // changing the last successful build.
  const outputDir = resolveBuildOutputDir(projectRoot, config.build.output_dir);
  const vendorAssetSources = resolveVendorAssetSources();
  const figureCleanup = cleanupOrphanedGenerationFigures(store, projectRoot);
  if (figureCleanup.failures > 0) {
    console.warn(`Could not clean ${figureCleanup.failures} orphaned generation figure(s)`);
  }
  const parentDir = dirname(outputDir);
  mkdirSync(parentDir, { recursive: true });

  const token = `${process.pid}-${randomUUID()}`;
  const stagingDir = join(parentDir, `.${basename(outputDir)}.staging-${token}`);
  const backupDir = join(parentDir, `.${basename(outputDir)}.backup-${token}`);

  try {
    const pageCount = await renderSiteToDirectory(store, config, projectRoot, stagingDir, vendorAssetSources);
    validateStagedSite(stagingDir);
    await options.beforePublish?.();
    store.publishContent(() => publishStagedSite(stagingDir, outputDir, backupDir));
    return pageCount;
  } finally {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    // A backup only remains after an operator-actionable cleanup or rollback
    // failure. Never remove it here: it may be the sole copy of the old site.
  }
}

/**
 * Render a complete site from the prospective ingest generation, then publish
 * that directory in the same fenced SQLite transaction as the live reconcile.
 * Ordinary build, rename, fence, and commit failures retain the previous
 * matched DB/site pair; this is process-local compensation, not a power-loss
 * atomic filesystem/SQLite protocol.
 */
export async function publishIngestGenerationWithSite(
  liveStore: Store,
  ingestStagingStore: Store,
  stagingSourceId: number,
  draft: IngestSourceDraft,
  contentHash: string,
  config: KiwiConfig,
  projectRoot: string,
  options: PublishIngestSiteOptions = {},
): Promise<{ source: Source; pageCount: number }> {
  const outputDir = resolveBuildOutputDir(projectRoot, config.build.output_dir);
  const vendorAssetSources = resolveVendorAssetSources();
  const parentDir = dirname(outputDir);
  mkdirSync(parentDir, { recursive: true });

  const token = `${process.pid}-${randomUUID()}`;
  const stagingDir = join(parentDir, `.${basename(outputDir)}.staging-${token}`);
  const backupDir = join(parentDir, `.${basename(outputDir)}.backup-${token}`);
  const candidateDbPath = join(parentDir, `.${basename(outputDir)}.candidate-${token}.db`);
  const publication = stagedSitePublication(
    stagingDir,
    outputDir,
    backupDir,
    options.renameDirectory,
  );
  let candidateStore: Store | null = null;

  try {
    liveStore.writeSnapshot(candidateDbPath);
    candidateStore = new Store(candidateDbPath);
    candidateStore.publishIngestGeneration(
      ingestStagingStore,
      stagingSourceId,
      draft,
      contentHash,
    );

    const pageCount = await renderSiteToDirectory(
      candidateStore,
      config,
      projectRoot,
      stagingDir,
      vendorAssetSources,
    );
    if (options.stagedFigureDirectory) {
      copyStagedFiguresForCandidate(
        options.stagedFigureDirectory,
        join(stagingDir, "static", "figures"),
        candidateStore.listFigurePaths(),
      );
    }
    validateStagedSite(stagingDir);
    candidateStore.close();
    candidateStore = null;

    await options.beforePublish?.();

    let source: Source;
    try {
      source = liveStore.publishIngestGeneration(
        ingestStagingStore,
        stagingSourceId,
        draft,
        contentHash,
        () => {
          publication.publish();
          options.publishFiles?.();
          options.afterDirectoryPublish?.();
        },
      );
    } catch (publishError) {
      try {
        publication.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [publishError, rollbackError],
          `Failed to publish ingest generation and restore the previous site. Recovery backup is preserved at "${backupDir}".`,
        );
      }
      throw publishError;
    }

    publication.complete();
    return { source, pageCount };
  } finally {
    candidateStore?.close();
    for (const path of [candidateDbPath, `${candidateDbPath}-wal`, `${candidateDbPath}-shm`]) {
      if (existsSync(path)) rmSync(path, { force: true });
    }
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    // As with buildSite, a backup is retained when rollback/cleanup failed and
    // may be the operator's sole known-good site generation.
  }
}

export async function buildSinglePage(
  root: string,
  store: Store,
  slug: string,
  options: BuildSinglePageOptions = {},
): Promise<void> {
  const page = options.candidate?.page ?? store.getPage(slug);
  if (!page) return;
  if (page.slug !== slug) throw new Error("Single-page candidate slug does not match the build target");

  const config = loadConfig(root);
  const siteDir = resolveBuildOutputDir(root, config.build?.output_dir || "_site");
  const wikiDir = join(siteDir, "wiki");
  mkdirSync(wikiDir, { recursive: true });

  const sourcePages = store.listSourcePages();
  const conceptPages = store.listConceptPages();
  const wikiName = config.project.name;
  const backlinksMap = store.getAllBacklinksGrouped();

  const sourceUriMap = new Map<number, string>();
  for (const s of store.listSources()) sourceUriMap.set(s.id, s.uri);
  const sourcePageLinks = sourcePages.map((sourcePage) => toSourcePageLink(sourcePage, sourceUriMap));

  // Render the single page
  const renderedContent = await renderPageContent(page);
  const { html: htmlContent, toc } = decorateHeadingsAndGenerateToc(renderedContent);

  const { body, externalRefs } = extractExternalRefs(htmlContent);
  const firstFigure = htmlContent.match(new RegExp(`<img[^>]+src="(${FIGURE_PUBLIC_PREFIX}[^"]+)"`, "i"));
  const seo: SiteSeo = { siteUrl: resolveSiteUrl(config, root), lang: config.build?.lang };
  const backlinks = (backlinksMap.get(page.id) || []).map((bl) => ({
    slug: bl.slug,
    title: bl.title,
    pageType: bl.page_type,
  }));

  // Citations footer
  const citations = options.candidate?.citations ?? store.getCitationsForPage(page.id);
  const citationsHtml = renderCitationFootnotes(citations);

  const html = injectContentSecurityPolicyMeta(renderPage({
    wikiName,
    pageTitle: page.title,
    pageSlug: page.slug,
    pageType: page.page_type,
    pageId: page.id,
    origin: page.origin,
    content: body,
    externalRefs,
    toc,
    backlinks,
    citationsHtml,
    sourcePages: sourcePageLinks,
    conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title, origin: p.origin })),
    categories: config.categories,
    seo,
    ogImage: firstFigure?.[1],
  }));

  // Build the search index before publication so its matching page and index
  // replacements can be fenced and committed together.
  const searchIndexPath = join(siteDir, "search-index.json");
  let searchData: Array<{ slug: string; title: string; preview: string; type: string }> = [];
  if (existsSync(searchIndexPath)) {
    try {
      searchData = JSON.parse(readFileSync(searchIndexPath, "utf-8"));
    } catch {
      searchData = [];
    }
  }
  // Remove existing entry for this slug if any
  searchData = searchData.filter((p) => p.slug !== page.slug);
  // Append new entry
  searchData.push({
    slug: page.slug,
    title: page.title,
    preview: page.content.slice(0, 200),
    type: page.page_type,
  });

  const stagedFiles: StagedFile[] = [];
  let publicationInvoked = false;
  try {
    stagedFiles.push(stageFileForPublication(join(wikiDir, `${page.slug}.html`), html));
    stagedFiles.push(stageFileForPublication(searchIndexPath, JSON.stringify(searchData)));
    await options.beforePublish?.();
    publicationInvoked = true;
    store.publishContent(() => {
      options.commitCandidate?.();
      publishStagedFiles(stagedFiles, options.renameFile);
    });
  } finally {
    // publishStagedFiles normally does this itself; this also covers a fence
    // assertion or async lease check that rejects before final publication.
    for (const file of stagedFiles) {
      removeIfPresent(file.temporaryPath);
      if (!publicationInvoked) removeIfPresent(file.backupPath);
    }
  }
}
