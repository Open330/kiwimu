import {
  assertExtractedTextWithinLimit,
  inspectZipArchive,
  readSourceFileWithinLimit,
} from "./limits";
import { awaitWithAbort, throwIfAborted } from "../abort";

export async function extractTextFromDocx(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ title: string; text: string }> {
  const buffer = await readSourceFileWithinLimit(filePath, undefined, signal);
  throwIfAborted(signal);
  inspectZipArchive(buffer);
  const mammoth = await import("mammoth");
  const result = await awaitWithAbort(mammoth.extractRawText({ buffer }), signal);
  throwIfAborted(signal);
  const text = assertExtractedTextWithinLimit(result.value, "DOCX text");
  const title = filePath.split("/").pop()?.replace(/\.docx?$/i, "") || "Untitled";
  return { title, text };
}
