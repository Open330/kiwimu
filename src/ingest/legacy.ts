/**
 * Extract text from legacy formats (DOC, PPT, KEY) using macOS textutil/CLI tools.
 */
import {
  assertExtractedTextWithinLimit,
  assertSourceFileWithinLimit,
  runBoundedCommand,
  type BoundedCommandResult,
} from "./limits";
import { throwIfAborted } from "../abort";

const LEGACY_COMMAND_DEADLINE_MS = 30_000;
const LEGACY_STDOUT_LIMIT_BYTES = 20 * 1024 * 1024;
const LEGACY_STDERR_LIMIT_BYTES = 64 * 1024;

type LegacyCommandRunner = (command: string[], signal?: AbortSignal) => Promise<BoundedCommandResult>;

const runLegacyCommand: LegacyCommandRunner = (command, signal) => runBoundedCommand(command, {
  deadlineMs: LEGACY_COMMAND_DEADLINE_MS,
  maxStdoutBytes: LEGACY_STDOUT_LIMIT_BYTES,
  maxStderrBytes: LEGACY_STDERR_LIMIT_BYTES,
  signal,
});

export async function extractWithTextutil(
  filePath: string,
  runCommand: LegacyCommandRunner = runLegacyCommand,
  signal?: AbortSignal,
): Promise<{ title: string; text: string }> {
  throwIfAborted(signal);
  assertSourceFileWithinLimit(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const title = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") || "Untitled";

  // textutil supports: doc, docx, rtf, rtfd, html, webarchive, odt, wordml
  const textutilFormats = new Set(["doc", "rtf", "odt"]);

  if (textutilFormats.has(ext)) {
    const result = await runCommand(["textutil", "-convert", "txt", "-stdout", "--", filePath], signal);
    if (result.exitCode !== 0) {
      throw new Error(`textutil failed: ${result.stderr}`);
    }
    return { title, text: assertExtractedTextWithinLimit(result.stdout, "Legacy document text") };
  }

  // For .key (Keynote), try mdimport for metadata or strings extraction
  if (ext === "key") {
    // Try to extract text using mdimport/spotlight metadata
    try {
      await runCommand(["mdimport", "-d2", "--", filePath], signal);
    } catch {
      throwIfAborted(signal);
    }

    // Keynote files are directories or zip-like packages. Try strings extraction.
    const result = await runCommand(["strings", "--", filePath], signal);
    if (result.exitCode !== 0) throw new Error(`strings failed: ${result.stderr}`);
    const raw = result.stdout;

    // Filter to lines that look like actual text content
    const lines = raw.split("\n").filter((l) => {
      const t = l.trim();
      return t.length > 10 && /[a-zA-Z가-힣]/.test(t) && !/^[{<\[]/.test(t);
    });

    if (!lines.length) {
      throw new Error("Keynote 파일에서 텍스트를 추출할 수 없습니다. PDF로 내보내기 후 다시 시도해주세요.");
    }

    return { title, text: assertExtractedTextWithinLimit(lines.join("\n"), "Keynote text") };
  }

  // For .ppt (legacy PowerPoint), try textutil or strings
  if (ext === "ppt") {
    const result = await runCommand(["strings", "--", filePath], signal);
    if (result.exitCode !== 0) throw new Error(`strings failed: ${result.stderr}`);
    const raw = result.stdout;

    const lines = raw.split("\n").filter((l) => {
      const t = l.trim();
      return t.length > 5 && /[a-zA-Z가-힣]/.test(t) && !/^[{<\[\x00-\x1f]/.test(t);
    });

    return { title, text: assertExtractedTextWithinLimit(lines.join("\n"), "Legacy PowerPoint text") };
  }

  throw new Error(`지원하지 않는 파일 형식: .${ext}`);
}
