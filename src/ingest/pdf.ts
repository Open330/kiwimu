import { createRequire } from "node:module";
import {
  assertExtractedTextWithinLimit,
  readSourceFileWithinLimit,
} from "./limits";
import { throwIfAborted } from "../abort";

const require = createRequire(import.meta.url);

export async function extractTextFromPdf(
  pdfPath: string,
  signal?: AbortSignal,
): Promise<{ title: string; text: string }> {
  // pdf-parse performs CPU work in-process and cannot be forcibly interrupted.
  // Bound the input before parsing and reject oversized output afterwards;
  // do not present a Promise timeout as cancellation of that CPU work.
  const buffer = await readSourceFileWithinLimit(pdfPath, undefined, signal);
  throwIfAborted(signal);

  let pdfParse: (buffer: Buffer) => Promise<{ info?: { Title?: string }; text: string }>;
  try {
    // Import the library entry directly. pdf-parse 1.1.1's package entry
    // mistakes Bun ESM loading for its CLI debug mode and reads a test file.
    pdfParse = require("pdf-parse/lib/pdf-parse.js");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "MODULE_NOT_FOUND") {
      throw new Error("PDF support requires pdf-parse. Run: bun add pdf-parse");
    }
    throw error;
  }

  // pdf-parse does CPU work in-process and exposes no cancellation hook. This
  // post-parse checkpoint prevents publication, but cannot preempt its CPU work.
  const data = await pdfParse(buffer);
  throwIfAborted(signal);

  const title = data.info?.Title || pdfPath.split("/").pop()?.replace(".pdf", "") || "Untitled";
  return { title, text: assertExtractedTextWithinLimit(data.text, "PDF text") };
}
