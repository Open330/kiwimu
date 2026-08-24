import { createHash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  Store,
  type ContentFence,
  type IngestSourceDraft,
  type Source,
} from "../store";
import type { LLMConfig, Persona, WikiSchema } from "../config";
import { GENERATION_FIGURE_FILENAME_PATTERN } from "./figure-maintenance";

const STAGING_DIRECTORY = ".kiwimu-ingest-staging";
const FIGURE_PUBLIC_PREFIX = "/static/figures/";
const STAGING_GENERATION_PATTERN = /^([a-f0-9]{24})-[a-f0-9]{32}-[a-f0-9]{32}-[a-f0-9]{32}\.db(?:-wal|-shm|\.figures)?$/;

/** Keep same-owner retries briefly, but bound abandoned owner generations. */
export const INGEST_STAGING_MINIMUM_AGE_MS = 24 * 60 * 60 * 1_000;
export const INGEST_STAGING_TTL_MS = 7 * INGEST_STAGING_MINIMUM_AGE_MS;
export const INGEST_STAGING_MAX_GENERATIONS_PER_SOURCE = 3;

export interface IngestStagingHandle {
  store: Store;
  source: Source;
  dbPath: string;
  sourceKey: string;
  /** Checkpoint binding for both input bytes and generation-affecting config. */
  checkpointHash: string;
}

export interface IngestGenerationInputs {
  sourceType: string;
  title: string;
  extractFigures: boolean;
}

// Bump whenever prompt/pipeline semantics become checkpoint-incompatible.
const INGEST_PIPELINE_VERSION = "generation-staging-v2";

function sourceKey(uri: string): string {
  return createHash("sha256").update(uri).digest("hex").slice(0, 24);
}

function generationKey(contentHash: string): string {
  if (!/^[a-f0-9]{32,128}$/i.test(contentHash)) {
    throw new TypeError("Ingest content hash must be hexadecimal");
  }
  return contentHash.toLowerCase().slice(0, 32);
}

function validateFingerprint(fingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new TypeError("Ingest generation fingerprint must be a SHA-256 digest");
  }
  return fingerprint;
}

function ownershipKey(fence: ContentFence): string {
  return createHash("sha256").update(stableJson({
    resource: fence.resource,
    epoch: fence.epoch,
    ownerToken: fence.ownerToken,
    fencingToken: fence.fencingToken,
  })).digest("hex").slice(0, 32);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** Canonical, secret-free identity for every input that changes generation output. */
export function createIngestGenerationFingerprint(
  llm: LLMConfig,
  persona: Persona | null,
  schema: WikiSchema | undefined,
  inputs: IngestGenerationInputs,
): string {
  return createHash("sha256").update(stableJson({
    pipelineVersion: INGEST_PIPELINE_VERSION,
    llm: {
      provider: llm.provider.trim(),
      model: llm.model.trim(),
      endpoint: llm.endpoint.trim().replace(/\/+$/, ""),
    },
    persona: persona ? {
      name: persona.name,
      systemPrompt: persona.system_prompt,
      contentStyle: persona.content_style,
    } : null,
    schema: schema ?? null,
    inputs,
  })).digest("hex");
}

function prepareStagingDirectory(root: string): string {
  const directory = join(root, STAGING_DIRECTORY);
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe ingest staging path: ${directory}`);
    }
  } else {
    mkdirSync(directory, { mode: 0o700 });
  }
  chmodSync(directory, 0o700);
  return directory;
}

export interface IngestStagingCleanupOptions {
  /** Exact generation currently being opened or used. */
  protectedDbPath?: string;
  now?: number;
  minimumAgeMs?: number;
  ttlMs?: number;
  maxGenerationsPerSource?: number;
}

export interface IngestStagingCleanupResult {
  removed: number;
  failures: number;
}

interface StagingGeneration {
  dbPath: string;
  sourceKey: string;
  modifiedAt: number;
  hasDatabase: boolean;
}

/**
 * Best-effort GC for KiwiMu-owned staging generations.
 *
 * Unknown names and symlinks are never touched. A minimum-age floor protects
 * recent work, while TTL and a per-source cap prevent abandoned generations
 * from accumulating indefinitely.
 */
export function cleanupAbandonedIngestStaging(
  directory: string,
  options: IngestStagingCleanupOptions = {},
): IngestStagingCleanupResult {
  const now = options.now ?? Date.now();
  const minimumAgeMs = options.minimumAgeMs ?? INGEST_STAGING_MINIMUM_AGE_MS;
  const ttlMs = options.ttlMs ?? INGEST_STAGING_TTL_MS;
  const maxPerSource = options.maxGenerationsPerSource ?? INGEST_STAGING_MAX_GENERATIONS_PER_SOURCE;
  if (![now, minimumAgeMs, ttlMs].every(Number.isFinite) || minimumAgeMs < 0 || ttlMs < minimumAgeMs) {
    throw new TypeError("Invalid ingest staging cleanup age policy");
  }
  if (!Number.isSafeInteger(maxPerSource) || maxPerSource < 1) {
    throw new TypeError("Ingest staging generation cap must be a positive integer");
  }
  if (!existsSync(directory)) return { removed: 0, failures: 0 };
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Unsafe ingest staging path: ${directory}`);
  }

  const generations = new Map<string, StagingGeneration>();
  for (const entry of readdirSync(directory)) {
    const match = entry.match(STAGING_GENERATION_PATTERN);
    if (!match) continue;
    const candidate = join(directory, entry);
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) continue;
      const dbName = entry.replace(/(?:-wal|-shm|\.figures)$/, "");
      const dbPath = join(directory, dbName);
      const generation = generations.get(dbName) ?? {
        dbPath,
        sourceKey: match[1],
        modifiedAt: 0,
        hasDatabase: false,
      };
      if (entry === dbName) {
        generation.modifiedAt = stat.mtimeMs;
        generation.hasDatabase = true;
      } else if (!generation.hasDatabase) {
        generation.modifiedAt = Math.max(generation.modifiedAt, stat.mtimeMs);
      }
      generations.set(dbName, generation);
    } catch {
      // A concurrently disappearing abandoned entry needs no further cleanup.
    }
  }

  const protectedDbPath = options.protectedDbPath ? join(dirname(options.protectedDbPath), basename(options.protectedDbPath)) : null;
  const bySource = new Map<string, StagingGeneration[]>();
  for (const generation of generations.values()) {
    const group = bySource.get(generation.sourceKey) ?? [];
    group.push(generation);
    bySource.set(generation.sourceKey, group);
  }

  let removed = 0;
  let failures = 0;
  for (const group of bySource.values()) {
    group.sort((a, b) => b.modifiedAt - a.modifiedAt || b.dbPath.localeCompare(a.dbPath));
    for (const [index, generation] of group.entries()) {
      if (generation.dbPath === protectedDbPath) continue;
      const ageMs = Math.max(0, now - generation.modifiedAt);
      if (ageMs < minimumAgeMs) continue;
      if (ageMs < ttlMs && index < maxPerSource) continue;
      try {
        removeStagingGeneration(generation.dbPath);
        removed++;
      } catch {
        failures++;
      }
    }
  }
  return { removed, failures };
}

/** Open or create the durable Store bound to one input, config and fence owner. */
export function openIngestStaging(
  root: string,
  liveStore: Store,
  draft: IngestSourceDraft,
  contentHash: string,
  generationFingerprint: string,
): IngestStagingHandle {
  const fence = liveStore.requireCurrentContentFence();
  const directory = prepareStagingDirectory(root);
  const key = sourceKey(draft.uri);
  const fingerprint = validateFingerprint(generationFingerprint);
  const dbPath = join(directory,
    `${key}-${generationKey(contentHash)}-${fingerprint.slice(0, 32)}-${ownershipKey(fence)}.db`);
  cleanupAbandonedIngestStaging(directory, { protectedDbPath: dbPath });
  const alreadyExists = existsSync(dbPath);
  const stagingStore = new Store(dbPath, {
    beforeMutation: () => liveStore.assertContentFence(fence),
  });

  try {
    let source = stagingStore.getSource(draft.uri);
    if (!alreadyExists) {
      source = stagingStore.seedIngestStaging(
        liveStore.createIngestStagingSnapshot(draft.uri),
        draft,
      );
    } else if (!source) {
      throw new Error(`Ingest staging database is incomplete: ${basename(dbPath)}`);
    }
    const checkpointHash = createHash("sha256")
      .update(`${generationKey(contentHash)}:${fingerprint}`)
      .digest("hex");
    return { store: stagingStore, source: source!, dbPath, sourceKey: key, checkpointHash };
  } catch (error) {
    stagingStore.close();
    if (!alreadyExists) removeSqliteFiles(dbPath);
    throw error;
  }
}

/** Remove the successful generation and obsolete generations for the source. */
export function cleanupIngestStaging(handle: Pick<IngestStagingHandle, "dbPath" | "sourceKey">): void {
  const directory = dirname(handle.dbPath);
  const prefix = `${handle.sourceKey}-`;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    if (/\.db(?:-wal|-shm)?$/.test(entry)) {
      rmSync(join(directory, entry), { force: true });
    } else if (entry.endsWith(".db.figures")) {
      rmSync(join(directory, entry), { recursive: true, force: true });
    }
  }
  if (readdirSync(directory).length === 0) rmdirSync(directory);
}

/** Create the private figure directory associated with this staged DB. */
export function prepareIngestFigureStaging(handle: Pick<IngestStagingHandle, "dbPath">): string {
  const directory = `${handle.dbPath}.figures`;
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe ingest figure staging path: ${directory}`);
  }
  chmodSync(directory, 0o700);
  return directory;
}

/** Namespace figures by immutable source identity and input generation, not a predicted DB ID. */
export function ingestFigurePrefix(
  handle: Pick<IngestStagingHandle, "sourceKey" | "dbPath">,
  contentHash: string,
): string {
  if (!/^[a-f0-9]{24}$/.test(handle.sourceKey)) {
    throw new TypeError("Ingest source key must be 24 lowercase hexadecimal characters");
  }
  const publicationKey = createHash("sha256")
    .update(basename(handle.dbPath))
    .digest("hex")
    .slice(0, 16);
  return `gen-${handle.sourceKey}-${generationKey(contentHash).slice(0, 12)}-${publicationKey}`;
}

interface ValidatedStagedFigure {
  name: string;
  source: string;
  metadata: Stats;
}

function listValidatedStagedFigures(stagingDirectory: string): ValidatedStagedFigure[] {
  if (!existsSync(stagingDirectory)) return [];
  const stagingStat = lstatSync(stagingDirectory);
  if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
    throw new Error(`Unsafe staged figure path: ${stagingDirectory}`);
  }
  return readdirSync(stagingDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const name = entry.name;
      if (!GENERATION_FIGURE_FILENAME_PATTERN.test(name)) {
        throw new Error(`Unsafe staged figure filename: ${name}`);
      }
      const source = join(stagingDirectory, name);
      const metadata = lstatSync(source);
      if (!entry.isFile() || metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Unsafe staged figure file: ${source}`);
      }
      return { name, source, metadata };
    });
}

/**
 * Copy DB-referenced files from the exact private ingest generation into a
 * not-yet-published candidate site's figures directory. Neither staging nor
 * live files are mutated, and an existing candidate target is never replaced.
 */
export function copyStagedFiguresForCandidate(
  stagingDirectory: string,
  candidateFiguresDirectory: string,
  dbFigurePaths: Iterable<string>,
): number {
  const figures = listValidatedStagedFigures(stagingDirectory);
  const parent = dirname(candidateFiguresDirectory);
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`Unsafe candidate figure parent: ${parent}`);
  }
  if (existsSync(candidateFiguresDirectory)) {
    const targetStat = lstatSync(candidateFiguresDirectory);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new Error(`Unsafe candidate figure path: ${candidateFiguresDirectory}`);
    }
  } else {
    mkdirSync(candidateFiguresDirectory, { mode: 0o700 });
  }

  const required = new Set<string>();
  for (const publicPath of dbFigurePaths) {
    if (!publicPath.startsWith(FIGURE_PUBLIC_PREFIX)) continue;
    const name = publicPath.slice(FIGURE_PUBLIC_PREFIX.length);
    if (GENERATION_FIGURE_FILENAME_PATTERN.test(name)) required.add(name);
  }

  const stagedByName = new Map(figures.map((figure) => [figure.name, figure]));
  let copied = 0;
  for (const name of required) {
    const target = join(candidateFiguresDirectory, name);
    if (existsSync(target)) {
      const targetStat = lstatSync(target);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new Error(`Unsafe candidate figure file: ${target}`);
      }
      continue;
    }
    const figure = stagedByName.get(name);
    if (!figure) throw new Error(`Candidate generation figure is missing: ${name}`);
    copyFileSync(figure.source, target, fsConstants.COPYFILE_EXCL);
    copied++;
  }
  return copied;
}

/**
 * Publish a complete unique-named figure set into the live figure directory.
 * Call this inside Store.publishIngestGeneration: a publication failure rolls
 * the DB transaction back; already linked files remain bounded fresh orphans.
 */
export function publishStagedFigures(stagingDirectory: string, liveDirectory: string): void {
  const validatedFigures = listValidatedStagedFigures(stagingDirectory);
  if (validatedFigures.length === 0) return;
  if (existsSync(liveDirectory)) {
    const liveStat = lstatSync(liveDirectory);
    if (liveStat.isSymbolicLink() || !liveStat.isDirectory()) {
      throw new Error(`Unsafe live figure path: ${liveDirectory}`);
    }
  } else {
    mkdirSync(liveDirectory, { recursive: true, mode: 0o700 });
  }
  chmodSync(liveDirectory, 0o700);

  const plans: Array<{
    source: string;
    target: string;
    alreadyLinked: boolean;
  }> = [];
  // Validate the complete set before moving the first byte. This prevents a
  // late unsafe entry or target collision from partially publishing the set.
  for (const figure of validatedFigures) {
    const { name, source, metadata: sourceStat } = figure;
    const target = join(liveDirectory, name);
    let targetStat: ReturnType<typeof lstatSync> | null = null;
    try {
      targetStat = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (targetStat) {
      const targetStat = lstatSync(target);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new Error(`Unsafe live figure file: ${target}`);
      }
      // Recover an interruption between link(target) and unlink(source).
      // No bytes are overwritten: both names already identify the same inode.
      if (targetStat.dev !== sourceStat.dev || targetStat.ino !== sourceStat.ino) {
        throw new Error(`Live generation figure already exists: ${target}`);
      }
    }
    plans.push({ source, target, alreadyLinked: targetStat !== null });
  }

  for (const { source, target, alreadyLinked } of plans) {
    // Durable staging can be old. Refresh it before the inode becomes visible
    // in live storage so age-based maintenance cannot race an uncommitted DB
    // publication and mistake this file for an abandoned generation.
    const publicationTime = new Date();
    utimesSync(source, publicationTime, publicationTime);
    // link() is exclusive when target is absent, unlike rename() which would
    // overwrite an existing DB-referenced file on POSIX.
    if (!alreadyLinked) linkSync(source, target);
    rmSync(source);
    chmodSync(target, 0o600);
  }
}

function removeSqliteFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function removeStagingGeneration(dbPath: string): void {
  const figureDirectory = `${dbPath}.figures`;
  if (existsSync(figureDirectory)) {
    const stat = lstatSync(figureDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe ingest figure staging path: ${figureDirectory}`);
    }
    rmSync(figureDirectory, { recursive: true, force: true });
  }
  removeSqliteFiles(dbPath);
}
