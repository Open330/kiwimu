import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  assertExtractedTextWithinLimit,
  assertSourceFileWithinLimit,
  IngestResourceLimitError,
  inspectZipArchive,
  readSourceFileWithinLimit,
  runBoundedCommand,
} from "./limits";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kiwimu-ingest-limits-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function zipFixture(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value, { createFolders: false });
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

describe("ingest resource limits", () => {
  test("bounds regular-file input before and after reading", async () => {
    const path = join(temporaryRoot(), "source.bin");
    writeFileSync(path, "12345");
    expect(assertSourceFileWithinLimit(path, 5)).toBeUndefined();
    expect((await readSourceFileWithinLimit(path, 5)).toString()).toBe("12345");

    truncateSync(path, 6);
    expect(() => assertSourceFileWithinLimit(path, 5)).toThrow(IngestResourceLimitError);
    expect(() => assertSourceFileWithinLimit(temporaryRoot(), 5)).toThrow("regular file");
  });

  test("rejects extracted text instead of silently truncating it", () => {
    expect(assertExtractedTextWithinLimit("12345", "fixture", 5)).toBe("12345");
    expect(() => assertExtractedTextWithinLimit("123456", "fixture", 5))
      .toThrow("5-code-unit");
  });

  test("reads central-directory sizes without inflating entries", async () => {
    const archive = await zipFixture({ "word/document.xml": "A".repeat(1_000), "small.txt": "ok" });
    const metadata = inspectZipArchive(archive, {
      maxEntries: 2,
      maxEntryUncompressedBytes: 1_000,
      maxTotalUncompressedBytes: 1_002,
    });
    expect(metadata.entries).toEqual([
      { name: "word/document.xml", uncompressedBytes: 1_000 },
      { name: "small.txt", uncompressedBytes: 2 },
    ]);
    expect(metadata.totalUncompressedBytes).toBe(1_002);
  });

  test("enforces ZIP entry-count, per-entry, and declared-total limits", async () => {
    const archive = await zipFixture({ "one.txt": "1234", "two.txt": "5678" });
    expect(() => inspectZipArchive(archive, {
      maxEntries: 1,
      maxEntryUncompressedBytes: 10,
      maxTotalUncompressedBytes: 20,
    })).toThrow("entry limit");
    expect(() => inspectZipArchive(archive, {
      maxEntries: 2,
      maxEntryUncompressedBytes: 3,
      maxTotalUncompressedBytes: 20,
    })).toThrow("uncompressed limit");
    expect(() => inspectZipArchive(archive, {
      maxEntries: 2,
      maxEntryUncompressedBytes: 4,
      maxTotalUncompressedBytes: 7,
    })).toThrow("total uncompressed limit");
  });

  test("boundedly rejects an archive whose local and central sizes are both forged", async () => {
    const archive = await zipFixture({ "word/document.xml": "A".repeat(2 * 1024 * 1024) });
    const centralOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    // Preserve the compressed payload but forge both declared sizes to bypass
    // a local-vs-central metadata comparison.
    archive.writeUInt32LE(3, localOffset + 22);
    archive.writeUInt32LE(3, centralOffset + 24);

    expect(() => inspectZipArchive(archive)).toThrow("declared and actual sizes");
  });

  test("bounds subprocess pipes and kills work at the wall-clock deadline", async () => {
    const success = await runBoundedCommand(
      [process.execPath, "-e", 'process.stdout.write("안녕"); process.stderr.write("note")'],
      { deadlineMs: 2_000, maxStdoutBytes: 16, maxStderrBytes: 16 },
    );
    expect(success).toEqual({ exitCode: 0, stdout: "안녕", stderr: "note" });

    await expect(runBoundedCommand(
      [process.execPath, "-e", 'process.stdout.write("x".repeat(1000)); await Bun.sleep(10_000)'],
      { deadlineMs: 2_000, maxStdoutBytes: 10, maxStderrBytes: 16 },
    )).rejects.toThrow("stdout");

    const startedAt = Date.now();
    await expect(runBoundedCommand(
      [process.execPath, "-e", "await Bun.sleep(10_000)"],
      { deadlineMs: 100, maxStdoutBytes: 16, maxStderrBytes: 16 },
    )).rejects.toThrow("execution deadline");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 8_000);

  test("kills a converter when its caller is cancelled before the deadline", async () => {
    const reason = new Error("shutdown interrupted converter");
    const controller = new AbortController();
    const startedAt = Date.now();
    const completion = runBoundedCommand(
      [process.execPath, "-e", "await Bun.sleep(10_000)"],
      {
        deadlineMs: 10_000,
        maxStdoutBytes: 16,
        maxStderrBytes: 16,
        signal: controller.signal,
      },
    );
    await Bun.sleep(20);
    controller.abort(reason);

    await expect(completion).rejects.toBe(reason);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 4_000);
});
