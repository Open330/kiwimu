import {
  assertExtractedTextWithinLimit,
  IngestResourceLimitError,
  inspectZipArchive,
  readSourceFileWithinLimit,
  type ZipEntryMetadata,
} from "./limits";
import { awaitWithAbort, throwIfAborted } from "../abort";

export const MAX_PPTX_SLIDES = 500;
export const MAX_PPTX_SLIDE_XML_BYTES = 4 * 1024 * 1024;
export const MAX_PPTX_TOTAL_SLIDE_XML_BYTES = 32 * 1024 * 1024;

interface PptxSlideLimits {
  maxSlides: number;
  maxSlideXmlBytes: number;
  maxTotalSlideXmlBytes: number;
}

export function assertPptxSlideLimits(
  slideEntries: ZipEntryMetadata[],
  limits: PptxSlideLimits = {
    maxSlides: MAX_PPTX_SLIDES,
    maxSlideXmlBytes: MAX_PPTX_SLIDE_XML_BYTES,
    maxTotalSlideXmlBytes: MAX_PPTX_TOTAL_SLIDE_XML_BYTES,
  },
): void {
  if (slideEntries.length > limits.maxSlides) {
    throw new IngestResourceLimitError(
      `PPTX exceeds the ${limits.maxSlides}-slide limit (${slideEntries.length} slides)`,
    );
  }
  let declaredSlideBytes = 0;
  for (const entry of slideEntries) {
    if (entry.uncompressedBytes > limits.maxSlideXmlBytes) {
      throw new IngestResourceLimitError(
        `PPTX slide ${entry.name} exceeds the ${limits.maxSlideXmlBytes}-byte XML limit (${entry.uncompressedBytes} bytes)`,
      );
    }
    declaredSlideBytes += entry.uncompressedBytes;
  }
  if (declaredSlideBytes > limits.maxTotalSlideXmlBytes) {
    throw new IngestResourceLimitError(
      `PPTX slide XML exceeds the ${limits.maxTotalSlideXmlBytes}-byte aggregate limit (${declaredSlideBytes} bytes)`,
    );
  }
}

export async function extractTextFromPptx(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ title: string; text: string }> {
  // PPTX is a ZIP containing XML files
  const JSZip = (await import("jszip")).default;

  const buffer = await readSourceFileWithinLimit(filePath, undefined, signal);
  throwIfAborted(signal);
  const archive = inspectZipArchive(buffer);
  const slideEntries = archive.entries.filter(({ name }) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assertPptxSlideLimits(slideEntries);
  const zip = await awaitWithAbort(JSZip.loadAsync(buffer), signal);

  const slides: string[] = [];

  // Parse each slide XML
  const slideFiles = Object.keys(zip.files)
    .filter((f) => f.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0");
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0");
      return numA - numB;
    });

  for (const slidePath of slideFiles) {
    throwIfAborted(signal);
    const xml = await awaitWithAbort(zip.files[slidePath]!.async("text"), signal);
    if (Buffer.byteLength(xml, "utf8") > MAX_PPTX_SLIDE_XML_BYTES) {
      throw new IngestResourceLimitError(
        `PPTX slide ${slidePath} exceeds the ${MAX_PPTX_SLIDE_XML_BYTES}-byte XML limit after extraction`,
      );
    }
    // Extract text from <a:t> tags
    const texts: string[] = [];
    const regex = /<a:t>([^<]*)<\/a:t>/g;
    let match;
    while ((match = regex.exec(xml))) {
      if (match[1].trim()) texts.push(match[1]);
    }
    if (texts.length) {
      slides.push(texts.join(" "));
    }
  }
  throwIfAborted(signal);

  const title = filePath.split("/").pop()?.replace(/\.pptx?$/i, "") || "Untitled";
  const text = assertExtractedTextWithinLimit(
    slides.map((s, i) => `Slide ${i + 1}:\n${s}`).join("\n\n"),
    "PPTX text",
  );
  return { title, text };
}
