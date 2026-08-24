import { statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { awaitWithAbort, throwIfAborted, withAbortDeadline } from "../abort";

export const MAX_SOURCE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_CHARS = 5_000_000;

export const DEFAULT_ZIP_LIMITS = {
  maxEntries: 4_096,
  maxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
} as const;

export interface ZipLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

export interface ZipEntryMetadata {
  name: string;
  uncompressedBytes: number;
}

export interface ZipArchiveMetadata {
  entries: ZipEntryMetadata[];
  totalUncompressedBytes: number;
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const MAX_ZIP_COMMENT_BYTES = 0xffff;

export class IngestResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestResourceLimitError";
  }
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function assertSourceFileWithinLimit(
  filePath: string,
  maxBytes: number = MAX_SOURCE_FILE_BYTES,
): void {
  assertPositiveLimit(maxBytes, "maxBytes");
  const metadata = statSync(filePath);
  if (!metadata.isFile()) {
    throw new Error("Source path must be a regular file");
  }
  if (metadata.size > maxBytes) {
    throw new IngestResourceLimitError(
      `Source file exceeds the ${maxBytes}-byte input limit (${metadata.size} bytes)`,
    );
  }
}

export async function readSourceFileWithinLimit(
  filePath: string,
  maxBytes: number = MAX_SOURCE_FILE_BYTES,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);
  assertSourceFileWithinLimit(filePath, maxBytes);
  const buffer = Buffer.from(await awaitWithAbort(Bun.file(filePath).arrayBuffer(), signal));
  throwIfAborted(signal);
  // Recheck after reading in case the file changed between stat and read.
  if (buffer.byteLength > maxBytes) {
    throw new IngestResourceLimitError(
      `Source file exceeds the ${maxBytes}-byte input limit (${buffer.byteLength} bytes)`,
    );
  }
  return buffer;
}

export function assertExtractedTextWithinLimit(
  text: string,
  label: string,
  maxChars: number = MAX_EXTRACTED_TEXT_CHARS,
): string {
  assertPositiveLimit(maxChars, "maxChars");
  if (text.length > maxChars) {
    throw new IngestResourceLimitError(
      `${label} exceeds the ${maxChars}-code-unit extracted-text limit (${text.length} UTF-16 code units)`,
    );
  }
  return text;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - (MAX_ZIP_COMMENT_BYTES + 22));
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset--) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  throw new Error("Invalid ZIP archive: end-of-central-directory record not found");
}

/**
 * Inspect standard ZIP metadata and boundedly verify each declared size.
 * ZIP64 and multi-disk archives are rejected because supported source files are
 * already far below the configured entry and input-size limits.
 */
export function inspectZipArchive(
  bytes: Uint8Array,
  overrides: Partial<ZipLimits> = {},
): ZipArchiveMetadata {
  const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...overrides };
  assertPositiveLimit(limits.maxEntries, "maxEntries");
  assertPositiveLimit(limits.maxEntryUncompressedBytes, "maxEntryUncompressedBytes");
  assertPositiveLimit(limits.maxTotalUncompressedBytes, "maxTotalUncompressedBytes");

  if (bytes.byteLength > MAX_SOURCE_FILE_BYTES) {
    throw new IngestResourceLimitError(
      `ZIP input exceeds the ${MAX_SOURCE_FILE_BYTES}-byte input limit (${bytes.byteLength} bytes)`,
    );
  }
  if (bytes.byteLength < 22) throw new Error("Invalid ZIP archive: file is too short");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralDirectoryBytes = view.getUint32(endOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("Unsupported ZIP archive: multi-disk archives are not accepted");
  }
  if (
    entryCount === ZIP64_SENTINEL_16 ||
    centralDirectoryBytes === ZIP64_SENTINEL_32 ||
    centralDirectoryOffset === ZIP64_SENTINEL_32
  ) {
    throw new Error("Unsupported ZIP archive: ZIP64 metadata is not accepted");
  }
  if (entryCount > limits.maxEntries) {
    throw new IngestResourceLimitError(
      `ZIP archive exceeds the ${limits.maxEntries}-entry limit (${entryCount} entries)`,
    );
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectoryBytes;
  if (
    !Number.isSafeInteger(centralDirectoryEnd) ||
    centralDirectoryOffset > endOffset ||
    centralDirectoryEnd > endOffset
  ) {
    throw new Error("Invalid ZIP archive: central directory is out of bounds");
  }

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntryMetadata[] = [];
  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralDirectoryEnd || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      throw new Error("Invalid ZIP archive: malformed central-directory entry");
    }

    const uncompressedBytes = view.getUint32(cursor + 24, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const checksum = view.getUint32(cursor + 16, true);
    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const entryLength = 46 + fileNameLength + extraLength + commentLength;
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    if (
      uncompressedBytes === ZIP64_SENTINEL_32 ||
      compressedBytes === ZIP64_SENTINEL_32 ||
      localHeaderOffset === ZIP64_SENTINEL_32
    ) {
      throw new Error("Unsupported ZIP archive: ZIP64 entry metadata is not accepted");
    }
    if (cursor + entryLength > centralDirectoryEnd) {
      throw new Error("Invalid ZIP archive: central-directory entry is out of bounds");
    }

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + fileNameLength);
    const name = decoder.decode(nameBytes);
    if (flags & 0x0001) {
      throw new Error(`Unsupported ZIP archive: encrypted entry ${name || "(unnamed)"} is not accepted`);
    }
    if (
      localHeaderOffset + 30 > centralDirectoryOffset ||
      view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE
    ) {
      throw new Error(`Invalid ZIP archive: local header for ${name || "(unnamed)"} is out of bounds`);
    }
    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localCompressionMethod = view.getUint16(localHeaderOffset + 8, true);
    const localFileNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedBytes;
    if (
      localFlags !== flags ||
      localCompressionMethod !== compressionMethod ||
      localFileNameLength !== fileNameLength ||
      dataEnd > centralDirectoryOffset ||
      !bytesEqual(
        bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localFileNameLength),
        nameBytes,
      )
    ) {
      throw new Error(`Invalid ZIP archive: local header for ${name || "(unnamed)"} is inconsistent`);
    }

    if (flags & 0x0008) {
      let descriptorOffset = dataEnd;
      if (
        descriptorOffset + 4 <= centralDirectoryOffset &&
        view.getUint32(descriptorOffset, true) === DATA_DESCRIPTOR_SIGNATURE
      ) {
        descriptorOffset += 4;
      }
      if (
        descriptorOffset + 12 > centralDirectoryOffset ||
        view.getUint32(descriptorOffset, true) !== checksum ||
        view.getUint32(descriptorOffset + 4, true) !== compressedBytes ||
        view.getUint32(descriptorOffset + 8, true) !== uncompressedBytes
      ) {
        throw new Error(`Invalid ZIP archive: data descriptor for ${name || "(unnamed)"} is inconsistent`);
      }
    } else if (
      view.getUint32(localHeaderOffset + 14, true) !== checksum ||
      view.getUint32(localHeaderOffset + 18, true) !== compressedBytes ||
      view.getUint32(localHeaderOffset + 22, true) !== uncompressedBytes
    ) {
      throw new Error(`Invalid ZIP archive: local and central sizes for ${name || "(unnamed)"} differ`);
    }
    const compressedData = bytes.subarray(dataOffset, dataEnd);
    const remainingTotalBytes = Math.max(0, limits.maxTotalUncompressedBytes - totalUncompressedBytes);
    const verificationLimit = Math.min(limits.maxEntryUncompressedBytes, remainingTotalBytes) + 1;
    let actualUncompressedBytes: number;
    if (compressionMethod === 0) {
      actualUncompressedBytes = compressedData.byteLength;
    } else if (compressionMethod === 8) {
      try {
        actualUncompressedBytes = inflateRawSync(compressedData, {
          maxOutputLength: verificationLimit,
        }).byteLength;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw new IngestResourceLimitError(
            `ZIP entry ${name || "(unnamed)"} exceeds its bounded uncompressed allowance`,
          );
        }
        throw new Error(`Invalid ZIP archive: compressed data for ${name || "(unnamed)"} is invalid`, { cause: error });
      }
    } else {
      throw new Error(`Unsupported ZIP archive: compression method ${compressionMethod} is not accepted`);
    }
    if (actualUncompressedBytes !== uncompressedBytes) {
      throw new Error(
        `Invalid ZIP archive: declared and actual sizes for ${name || "(unnamed)"} differ`,
      );
    }
    if (uncompressedBytes > limits.maxEntryUncompressedBytes) {
      throw new IngestResourceLimitError(
        `ZIP entry ${name || "(unnamed)"} exceeds the ${limits.maxEntryUncompressedBytes}-byte uncompressed limit (${uncompressedBytes} bytes)`,
      );
    }
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      throw new IngestResourceLimitError(
        `ZIP archive exceeds the ${limits.maxTotalUncompressedBytes}-byte total uncompressed limit (${totalUncompressedBytes} bytes)`,
      );
    }

    entries.push({ name, uncompressedBytes });
    cursor += entryLength;
  }

  if (cursor !== centralDirectoryEnd) {
    throw new Error("Invalid ZIP archive: central directory length is inconsistent");
  }
  return { entries, totalUncompressedBytes };
}

export interface BoundedCommandOptions {
  deadlineMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}

export interface BoundedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function killProcess(process: ReturnType<typeof Bun.spawn>): void {
  try {
    if (process.exitCode === null) process.kill("SIGKILL");
  } catch {
    // The process may have exited between the status check and signal.
  }
}

async function readStreamWithinLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<string> {
  assertPositiveLimit(maxBytes, `max${label}Bytes`);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new IngestResourceLimitError(
          `Legacy converter ${label} exceeds the ${maxBytes}-byte output limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/** Run a converter with a killable wall-clock deadline and bounded pipes. */
export async function runBoundedCommand(
  command: string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  assertPositiveLimit(options.deadlineMs, "deadlineMs");
  throwIfAborted(options.signal);
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const deadline = withAbortDeadline(
    options.deadlineMs,
    new IngestResourceLimitError(
      `Legacy converter exceeded the ${options.deadlineMs}ms execution deadline`,
    ),
    options.signal,
  );
  const abortProcess = () => killProcess(process);
  deadline.signal.addEventListener("abort", abortProcess, { once: true });

  const stdout = readStreamWithinLimit(process.stdout, options.maxStdoutBytes, "stdout");
  const stderr = readStreamWithinLimit(process.stderr, options.maxStderrBytes, "stderr");
  const exited = process.exited;
  const completion = Promise.all([stdout, stderr, exited])
    .then(([capturedStdout, capturedStderr, exitCode]) => ({
      stdout: capturedStdout,
      stderr: capturedStderr,
      exitCode,
    }));

  try {
    return await awaitWithAbort(completion, deadline.signal);
  } catch (error) {
    killProcess(process);
    await Promise.allSettled([stdout, stderr, exited]);
    throw error;
  } finally {
    deadline.signal.removeEventListener("abort", abortProcess);
    deadline.cleanup();
    await exited;
  }
}
