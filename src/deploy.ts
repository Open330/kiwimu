import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { injectContentSecurityPolicyMeta } from "./build/csp";

export interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface GhPagesDeployOptions {
  /** Explicit GitHub Pages mount path, for example `/kiwimu` or `/`. */
  basePath?: string;
  /** Project root used to read `git remote get-url origin`. */
  projectRoot?: string;
  /** Injected remote URL, mainly useful for callers that already resolved it. */
  remoteUrl?: string;
  /** Optional parent for the temporary deployment copy. */
  tempRoot?: string;
}

export interface PreparedGhPagesSite {
  siteDir: string;
  cleanup(): void;
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const REWRITABLE_EXTENSIONS = new Set([".html", ".js", ".css"]);
const KIWI_ROOT_ROUTE = /^\/(?:static(?:\/|$)|wiki(?:\/|$)|api(?:\/|$)|search-index\.json(?:[?#]|$)|graph-data\.json(?:[?#]|$)|(?:index|catalog|quiz|dashboard|graph|provenance)\.html(?:[?#]|$)|manage(?:[/?#]|$)|activity(?:[/?#]|$)|provenance(?:[/?#]|$)|favicon\.ico(?:[?#]|$))/;

function repositoryFromParts(ownerValue: string, repoValue: string): GitHubRepository {
  const owner = ownerValue.trim();
  const repo = repoValue.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!SAFE_PATH_SEGMENT.test(owner) || !SAFE_PATH_SEGMENT.test(repo)) {
    throw new Error(`Unsupported GitHub remote repository path: ${ownerValue}/${repoValue}`);
  }
  return { owner, repo };
}

/** Parse the common HTTPS, ssh://, and SCP-like GitHub remote formats. */
export function parseGitHubRemote(remoteUrl: string): GitHubRepository {
  const value = remoteUrl.trim();
  if (!value) throw new Error("GitHub remote URL is empty.");

  const scpLike = /^(?:[^@\s]+@)?github\.com:([^/\s]+)\/(.+)$/i.exec(value);
  if (scpLike) return repositoryFromParts(scpLike[1], scpLike[2]);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Unsupported GitHub remote URL "${value}". Expected https://github.com/owner/repo.git or git@github.com:owner/repo.git.`
    );
  }
  if (parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error(`Unsupported GitHub remote host "${parsed.hostname}"; expected github.com.`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`Unsupported GitHub remote repository path "${parsed.pathname}"; expected /owner/repo.git.`);
  }
  return repositoryFromParts(parts[0], parts[1]);
}

/** Normalize and validate a deployment mount path without allowing URL escapes. */
export function normalizeBasePath(basePath: string): string {
  const value = basePath.trim();
  if (!value) throw new Error("GitHub Pages base path cannot be empty. Use / for a root site.");
  const withoutTrailingSlash = value.length > 1 ? value.replace(/\/+$/, "") : value;
  if (
    value.startsWith("//") ||
    withoutTrailingSlash.includes("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.includes("%")
  ) {
    throw new Error(`Unsafe GitHub Pages base path "${basePath}".`);
  }
  const withLeadingSlash = withoutTrailingSlash.startsWith("/") ? withoutTrailingSlash : `/${withoutTrailingSlash}`;
  const segments = withLeadingSlash.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || !SAFE_PATH_SEGMENT.test(segment))) {
    throw new Error(`Unsafe GitHub Pages base path "${basePath}".`);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** owner.github.io repositories mount at `/`; ordinary project sites mount at `/repo`. */
export function githubPagesBasePath(remoteUrl: string): string {
  const { owner, repo } = parseGitHubRemote(remoteUrl);
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? "/" : normalizeBasePath(repo);
}

/**
 * Infer the absolute GitHub Pages site origin plus base path from a remote URL,
 * for example `https://owner.github.io` or `https://owner.github.io/repo`.
 * The returned value never carries a trailing slash.
 */
export function githubPagesSiteUrl(remoteUrl: string): string {
  const { owner } = parseGitHubRemote(remoteUrl);
  const basePath = githubPagesBasePath(remoteUrl);
  const origin = `https://${owner.toLowerCase()}.github.io`;
  return basePath === "/" ? origin : `${origin}${basePath}`;
}

export function readGitOriginUrl(projectRoot: string): string {
  try {
    const output = execFileSync("git", ["-C", resolve(projectRoot), "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output) return output;
  } catch {
    // The actionable error below covers missing git, repository, and origin.
  }
  throw new Error(
    "Unable to infer the GitHub Pages base path because git remote 'origin' is unavailable. " +
    "Set it with --base-path /repository-name (or --base-path / for a root site)."
  );
}

export function resolveGhPagesBasePath(options: GhPagesDeployOptions = {}): string {
  if (options.basePath !== undefined) return normalizeBasePath(options.basePath);
  const remoteUrl = options.remoteUrl ?? readGitOriginUrl(options.projectRoot ?? process.cwd());
  return githubPagesBasePath(remoteUrl);
}

function prefixRootUrl(url: string, basePath: string): string {
  if (basePath === "/" || !url.startsWith("/") || url.startsWith("//")) return url;
  return url === "/" ? `${basePath}/` : `${basePath}${url}`;
}

/**
 * Rewrite root-mounted runtime references in generated text.
 *
 * This deliberately targets URL-bearing HTML attributes, root-leading string
 * literals, CSS url() values, and the shipped peek-panel pathname regexp. It
 * does not perform a blanket `/...` replacement, so external URLs, general
 * regular expressions, and HTML closing tags remain byte-for-byte intact.
 */
export function rewriteRootReferences(contents: string, requestedBasePath: string): string {
  const basePath = normalizeBasePath(requestedBasePath);
  if (basePath === "/") return contents;

  const protectedUrls: Array<{ token: string; url: string }> = [];
  const protectUrl = (url: string): string => {
    const token = `\uE000kiwimu-root-${protectedUrls.length}\uE001`;
    protectedUrls.push({ token, url: prefixRootUrl(url, basePath) });
    return token;
  };

  // Protect URL-specific syntaxes first. This also avoids ambiguous
  // double-prefixing when a repository itself is named `wiki` or `static`.
  let rewritten = contents.replace(
    /(\b(?:href|src|action)\s*=\s*)(["'])(\/(?!\/)[^"'`\s>]*)/gi,
    (_match, attribute: string, quote: string, url: string) => `${attribute}${quote}${protectUrl(url)}`,
  );

  rewritten = rewritten.replace(
    /(url\(\s*)(\/(?!\/)[^)\s"']+)/gi,
    (_match, prefix: string, url: string) => `${prefix}${protectUrl(url)}`,
  );

  rewritten = rewritten.replace(
    /(["'`])(\/(?!\/)[^"'`\r\n]*)\1/g,
    (_match, quote: string, url: string) =>
      `${quote}${KIWI_ROOT_ROUTE.test(url) ? prefixRootUrl(url, basePath) : url}${quote}`,
  );

  // A bare slash is ambiguous in JavaScript (`event.key === "/"` is not a
  // URL), so rewrite it only in URL-taking call/assignment contexts.
  rewritten = rewritten.replace(
    /(\bfetch\(\s*|(?:window\.)?location\.href\s*=\s*)(["'`])\/\2/g,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${basePath}/${quote}`,
  );

  // peek-panel compares URL.pathname with an escaped regexp literal rather
  // than a string, so it needs one narrowly scoped source transformation.
  const wikiPattern = String.raw`^\/wiki\/`;
  const escapedBase = basePath.split("/").filter(Boolean).map((segment) => String.raw`\/${segment}`).join("");
  rewritten = rewritten.split(wikiPattern).join(String.raw`^${escapedBase}\/wiki\/`);

  for (const { token, url } of protectedUrls) {
    rewritten = rewritten.split(token).join(url);
  }

  return rewritten;
}

function rewriteStaticTree(directory: string, basePath: string, rewriteFiles: boolean = true): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to publish symbolic link from generated site: ${path}`);
    }
    if (metadata.isDirectory()) {
      // Third-party bundles contain many semantic slash-leading strings and do
      // not reference Kiwi Mu's mount path. Validate their tree for symlinks,
      // but preserve every vendor byte exactly as shipped.
      const childRewrite = rewriteFiles && !(entry.name === "vendor" && basename(directory) === "static");
      rewriteStaticTree(path, basePath, childRewrite);
      continue;
    }
    if (!rewriteFiles || !metadata.isFile() || !REWRITABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const original = readFileSync(path, "utf8");
    const rewrittenReferences = rewriteRootReferences(original, basePath);
    const rewritten = extname(entry.name).toLowerCase() === ".html"
      ? injectContentSecurityPolicyMeta(rewrittenReferences)
      : rewrittenReferences;
    if (rewritten !== original) writeFileSync(path, rewritten, "utf8");
  }
}

/** Copy a generated site into an isolated, disposable GitHub Pages staging tree. */
export function prepareGhPagesSite(
  sourceSiteDir: string,
  requestedBasePath: string,
  tempRoot: string = tmpdir(),
): PreparedGhPagesSite {
  const source = resolve(sourceSiteDir);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`Build directory not found: ${source}. Run 'kiwimu build' first.`);
  }
  const basePath = normalizeBasePath(requestedBasePath);
  const stagingRoot = mkdtempSync(join(resolve(tempRoot), "kiwimu-gh-pages-"));
  const stagedSite = join(stagingRoot, basename(source) || "site");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(stagingRoot, { recursive: true, force: true });
  };

  try {
    cpSync(source, stagedSite, { recursive: true, errorOnExist: true });
    rewriteStaticTree(stagedSite, basePath);
    writeFileSync(join(stagedSite, ".nojekyll"), "", { flag: "w" });
    return { siteDir: stagedSite, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function withPreparedGhPagesSite<T>(
  sourceSiteDir: string,
  basePath: string,
  operation: (stagedSiteDir: string) => Promise<T> | T,
  tempRoot?: string,
): Promise<T> {
  const prepared = prepareGhPagesSite(sourceSiteDir, basePath, tempRoot);
  try {
    return await operation(prepared.siteDir);
  } finally {
    prepared.cleanup();
  }
}

/** Existing two-argument callers remain valid; optional settings add safe base-path staging. */
export async function deployGhPages(
  siteDir: string,
  message = "deploy: update wiki",
  options: GhPagesDeployOptions = {},
): Promise<void> {
  const basePath = resolveGhPagesBasePath(options);
  const ghPages = await import("gh-pages");

  await withPreparedGhPagesSite(siteDir, basePath, (stagedSiteDir) => new Promise<void>((resolvePublish, reject) => {
    // `nojekyll` is supported by gh-pages at runtime (and documented by it),
    // but its bundled TypeScript declaration currently omits the field.
    const publishOptions = {
      message,
      // Publish no other hidden files from copied figures/assets. gh-pages
      // creates the one required marker explicitly in its worktree.
      dotfiles: false,
      nojekyll: true,
    };
    ghPages.publish(
      stagedSiteDir,
      publishOptions,
      (error) => {
        if (error) reject(error);
        else resolvePublish();
      }
    );
  }), options.tempRoot);
}

export async function deployVercel(siteDir: string): Promise<void> {
  const proc = Bun.spawn(["vercel", "--prod", siteDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error("Vercel deploy failed");
}
