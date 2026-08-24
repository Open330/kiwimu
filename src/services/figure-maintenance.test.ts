import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store";
import { cleanupOrphanedGenerationFigures } from "./figure-maintenance";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writePrivateFile(path: string, contents = "png"): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generation figure maintenance", () => {
  test("uses the DB allowlist and removes only a bounded set of owned generation files", () => {
    const root = temporaryRoot("kiwimu-figure-maintenance-");
    const figures = join(root, "figures");
    mkdirSync(figures);
    const store = new Store(":memory:");

    const approved = "src1-aaaaaaaaaaaa-1-1.png";
    const orphanA = "src1-bbbbbbbbbbbb-1-1.png";
    const orphanB = "src1-cccccccccccc-1-1.png";
    const orphanC = "src1-dddddddddddd-1-1.png";
    const operatorOwned = "src1-eeeeeeeeeeee-1-1.png";
    const linked = "src1-ffffffffffff-1-1.png";
    const directory = "src1-111111111111-1-1.png";
    const outside = join(root, "outside.png");

    try {
      const source = store.addSource("file:///figures.pdf", "pdf", "Figures", "raw");
      store.addFigure(source.id, `/static/figures/${approved}`);
      for (const name of [approved, orphanA, orphanB, orphanC]) {
        writePrivateFile(join(figures, name));
      }
      writeFileSync(join(figures, operatorOwned), "operator file", { mode: 0o644 });
      chmodSync(join(figures, operatorOwned), 0o644);
      writeFileSync(join(figures, "manual.png"), "manual");
      writeFileSync(join(figures, `${orphanA}.bak`), "manual backup");
      mkdirSync(join(figures, directory));
      writePrivateFile(outside, "outside");
      symlinkSync(outside, join(figures, linked));

      const first = cleanupOrphanedGenerationFigures(store, root, {
        maxDeletes: 2,
        minimumAgeMs: 0,
      });
      expect(first.deleted).toBe(2);
      expect(first.failures).toBe(0);
      expect(first.limitReached).toBeTrue();
      expect(existsSync(join(figures, orphanC))).toBeTrue();

      const second = cleanupOrphanedGenerationFigures(store, root, {
        maxDeletes: 10,
        minimumAgeMs: 0,
      });
      expect(second.deleted).toBe(1);
      expect(second.failures).toBe(0);
      expect(existsSync(join(figures, orphanC))).toBeFalse();

      for (const preserved of [approved, operatorOwned, "manual.png", `${orphanA}.bak`, directory, linked]) {
        expect(existsSync(join(figures, preserved))).toBeTrue();
      }
      expect(existsSync(outside)).toBeTrue();
    } finally {
      store.close();
    }
  });

  test("never traverses a symbolic-link figures root", () => {
    const root = temporaryRoot("kiwimu-figure-root-");
    const outside = temporaryRoot("kiwimu-figure-outside-");
    const orphan = join(outside, "src1-aaaaaaaaaaaa-1-1.png");
    writePrivateFile(orphan);
    symlinkSync(outside, join(root, "figures"));
    const store = new Store(":memory:");

    try {
      expect(cleanupOrphanedGenerationFigures(store, root)).toEqual({
        inspected: 0,
        deleted: 0,
        failures: 0,
        limitReached: false,
      });
      expect(existsSync(orphan)).toBeTrue();
    } finally {
      store.close();
    }
  });

  test("preserves a fresh file across a separate publisher process commit barrier", async () => {
    const root = temporaryRoot("kiwimu-figure-grace-");
    const figures = join(root, "figures");
    const staging = join(root, "staging");
    mkdirSync(figures);
    mkdirSync(staging);
    const filename = "src1-aaaaaaaaaaaa-1-1.png";
    const staged = join(staging, filename);
    const fresh = join(figures, filename);
    writePrivateFile(staged, "publisher bytes");
    const staleTimestamp = new Date(Date.now() - 10 * 60_000);
    utimesSync(staged, staleTimestamp, staleTimestamp);
    const store = new Store(":memory:");
    const ingestStagingUrl = new URL("./ingest-staging.ts", import.meta.url).href;
    const publisher = Bun.spawn([
      process.execPath,
      "-e",
      [
        `import { publishStagedFigures } from ${JSON.stringify(ingestStagingUrl)};`,
        `publishStagedFigures(${JSON.stringify(staging)}, ${JSON.stringify(figures)});`,
        'console.log("MOVED");',
        "for await (const _ of Bun.stdin.stream()) break;",
      ].join("\n"),
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

    try {
      const reader = publisher.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("MOVED");

      // The publishing process has moved the file but has not crossed its
      // simulated DB commit barrier. Its fresh mtime keeps maintenance away.
      const now = Date.now();
      expect(cleanupOrphanedGenerationFigures(store, root, { now }).deleted).toBe(0);
      expect(existsSync(fresh)).toBeTrue();

      const source = store.addSource("file:///fresh.pdf", "pdf", "Fresh", "raw");
      store.addFigure(source.id, `/static/figures/${filename}`);
      publisher.stdin.write("COMMIT\n");
      publisher.stdin.end();
      expect(await publisher.exited).toBe(0);

      const oldTimestamp = new Date(now - 5 * 60_000 - 1);
      utimesSync(fresh, oldTimestamp, oldTimestamp);
      expect(cleanupOrphanedGenerationFigures(store, root, { now }).deleted).toBe(0);
      expect(existsSync(fresh)).toBeTrue();
    } finally {
      if (publisher.exitCode === null) publisher.kill();
      store.close();
    }
  });

  test("rejects invalid cleanup limits without touching files", () => {
    const store = new Store(":memory:");
    try {
      expect(() => cleanupOrphanedGenerationFigures(store, ".", { maxDeletes: -1 })).toThrow(
        "figure cleanup limit must be a non-negative integer",
      );
    } finally {
      store.close();
    }
  });
});
