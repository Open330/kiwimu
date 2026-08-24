import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store } from "../store";

const FIGURE_PUBLIC_PREFIX = "/static/figures/";
const DEFAULT_MAX_DELETES = 64;
const DEFAULT_MINIMUM_AGE_MS = 5 * 60_000;

/**
 * Names in this namespace are created only by generation-staged PDF ingest.
 * Keep this deliberately narrower than the set of image formats the renderer
 * can publish: operator-managed images must never become cleanup candidates.
 */
export const GENERATION_FIGURE_FILENAME_PATTERN =
  /^(?:src[0-9]+-[a-f0-9]{8,32}|gen-[a-f0-9]{24}-[a-f0-9]{12}-[a-f0-9]{16})-[0-9]+-[0-9]+\.png$/;

export const GENERATION_FIGURE_PREFIX_PATTERN =
  /^(?:src[0-9]+(?:-[a-f0-9]{8,32})?|gen-[a-f0-9]{24}-[a-f0-9]{12}-[a-f0-9]{16})$/;

export interface FigureCleanupResult {
  inspected: number;
  deleted: number;
  failures: number;
  limitReached: boolean;
}

export interface FigureCleanupOptions {
  maxDeletes?: number;
  /** Grace period protecting files moved by a concurrent not-yet-committed publisher. */
  minimumAgeMs?: number;
  /** Injectable wall clock for deterministic maintenance tests. */
  now?: number;
}

function allowlistedGenerationNames(store: Store): Set<string> {
  const names = new Set<string>();
  for (const publicPath of store.listFigurePaths()) {
    if (!publicPath.startsWith(FIGURE_PUBLIC_PREFIX)) continue;
    const name = publicPath.slice(FIGURE_PUBLIC_PREFIX.length);
    if (GENERATION_FIGURE_FILENAME_PATTERN.test(name)) names.add(name);
  }
  return names;
}

/**
 * Remove a bounded number of abandoned, KiwiMu-owned generation figures.
 *
 * The current DB is the sole liveness allowlist. Cleanup is intentionally
 * limited to direct, owner-only (0600) regular files in the reserved generation
 * filename namespace. Symlinks, directories, legacy/operator images, and files
 * with user-managed permissions are left untouched.
 */
export function cleanupOrphanedGenerationFigures(
  store: Store,
  projectRoot: string,
  options: FigureCleanupOptions = {},
): FigureCleanupResult {
  const maxDeletes = options.maxDeletes ?? DEFAULT_MAX_DELETES;
  const minimumAgeMs = options.minimumAgeMs ?? DEFAULT_MINIMUM_AGE_MS;
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(maxDeletes) || maxDeletes < 0) {
    throw new TypeError("figure cleanup limit must be a non-negative integer");
  }
  if (!Number.isFinite(minimumAgeMs) || minimumAgeMs < 0) {
    throw new TypeError("figure cleanup minimum age must be non-negative");
  }
  if (!Number.isFinite(now)) throw new TypeError("figure cleanup clock must be finite");

  const result: FigureCleanupResult = {
    inspected: 0,
    deleted: 0,
    failures: 0,
    limitReached: false,
  };
  if (maxDeletes === 0) return result;

  const figuresRoot = resolve(projectRoot, "figures");
  let entries: string[];
  try {
    const rootMetadata = lstatSync(figuresRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return result;
    entries = readdirSync(figuresRoot).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failures++;
    return result;
  }

  let allowlisted: Set<string>;
  try {
    allowlisted = allowlistedGenerationNames(store);
  } catch {
    // A failed allowlist read must fail closed: delete nothing.
    result.failures++;
    return result;
  }
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  for (const name of entries) {
    result.inspected++;
    if (!GENERATION_FIGURE_FILENAME_PATTERN.test(name) || allowlisted.has(name)) continue;

    const candidate = join(figuresRoot, name);
    let metadata;
    try {
      metadata = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failures++;
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    const ageMs = Math.max(0, now - metadata.mtimeMs);
    if (metadata.nlink !== 1 || ageMs < minimumAgeMs) continue;

    // Published generation figures are owner-only. Treat a permission or owner
    // change as an operator taking ownership, and preserve the file.
    if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) continue;
    if (effectiveUid !== null && metadata.uid !== effectiveUid) continue;

    try {
      unlinkSync(candidate);
      result.deleted++;
    } catch {
      result.failures++;
    }
    if (result.deleted >= maxDeletes) {
      result.limitReached = true;
      break;
    }
  }
  return result;
}
