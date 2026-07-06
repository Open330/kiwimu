/**
 * Figure/diagram extraction pipeline stage.
 *
 * Extracts images from PDFs, captions them via a multimodal LLM (vision), and
 * embeds them into wiki source pages. Every external dependency (the image
 * extraction tool and the captioner) is injectable so the core embedding logic
 * (`attachFigures`) is unit-testable without a real PDF or a live vision call.
 */
import type { LLMClient } from "../llm-client";
import type { Store } from "../store";

export interface ExtractedFigure {
  /** Absolute path to the extracted image on disk (read by the captioner). */
  filePath: string;
  /** Public/served path referenced from markdown, e.g. "/static/figures/x.png". */
  publicPath: string;
  /** 1-based source page number the figure came from, if known. */
  pageNumber: number | null;
  /** 0-based extraction order. */
  index: number;
}

/** A function that returns a caption for an image on disk, or null to skip. */
export type Captioner = (fig: ExtractedFigure) => Promise<string | null>;

const CAPTION_PROMPT =
  "You are captioning a figure extracted from a study document. " +
  "Write a single concise caption (max 20 words) describing what this figure/diagram shows. " +
  "Reply with the caption text only — no quotes, no 'Figure:' prefix.";

/**
 * Build the production captioner from an LLM client. Returns null captions when
 * the provider lacks vision support (graceful skip) or when a call fails.
 */
export function makeVisionCaptioner(client: LLMClient): Captioner {
  return async (fig: ExtractedFigure): Promise<string | null> => {
    if (!client.supportsVision()) return null;
    try {
      const { readFile } = await import("fs/promises");
      const bytes = await readFile(fig.filePath);
      const base64 = bytes.toString("base64");
      const mime = fig.filePath.toLowerCase().endsWith(".jpg") || fig.filePath.toLowerCase().endsWith(".jpeg")
        ? "image/jpeg" : "image/png";
      const caption = await client.describeImage(base64, mime, CAPTION_PROMPT);
      return caption?.trim() || null;
    } catch {
      return null;
    }
  };
}

/**
 * Default PDF image extractor using poppler's `pdfimages` CLI if available.
 * Returns [] (graceful skip) when the tool is missing or extraction fails.
 */
export async function extractFiguresFromPdf(
  pdfPath: string,
  outDir: string,
  sourceId: number
): Promise<ExtractedFigure[]> {
  const { mkdirSync, existsSync, readdirSync } = await import("fs");
  mkdirSync(outDir, { recursive: true });

  const prefix = `src${sourceId}`;
  try {
    const proc = Bun.spawn(["pdfimages", "-png", "-p", pdfPath, `${outDir}/${prefix}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return [];
  } catch {
    // pdfimages not installed → graceful skip
    return [];
  }

  if (!existsSync(outDir)) return [];
  const files = readdirSync(outDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".png"))
    .sort();

  return files.map((f, index) => {
    // pdfimages -p names files "<prefix>-<page>-<num>.png"
    const m = f.match(/-(\d+)-\d+\.png$/);
    return {
      filePath: `${outDir}/${f}`,
      publicPath: `/static/figures/${f}`,
      pageNumber: m ? parseInt(m[1], 10) : null,
      index,
    };
  });
}

export interface AttachFiguresResult {
  figureCount: number;
  captionedCount: number;
}

/**
 * Persist figures to the store and embed them into a source page's markdown.
 *
 * - `targetPageId`: page to embed into. If omitted, the first source page of the
 *   source is used. If there is no source page, figures are still persisted
 *   (page_id = null) but not embedded.
 * - Idempotent per source: existing figure rows for the source are cleared first,
 *   so re-ingest (incremental path) does not duplicate figures.
 */
export async function attachFigures(opts: {
  store: Store;
  sourceId: number;
  figures: ExtractedFigure[];
  captioner: Captioner;
  targetPageId?: number | null;
  onProgress?: (status: string) => void;
}): Promise<AttachFiguresResult> {
  const { store, sourceId, figures, captioner, onProgress } = opts;
  if (figures.length === 0) return { figureCount: 0, captionedCount: 0 };

  // Idempotency: drop any figures previously extracted for this source.
  store.deleteFiguresBySource(sourceId);

  let targetPageId = opts.targetPageId ?? null;
  if (targetPageId == null) {
    const srcPages = store.getSourcePages(sourceId);
    targetPageId = srcPages[0]?.id ?? null;
  }

  let captionedCount = 0;
  const blocks: string[] = [];

  for (const fig of figures) {
    let caption: string | null = null;
    try {
      caption = await captioner(fig);
    } catch {
      caption = null;
    }
    if (caption) captionedCount++;
    onProgress?.(`그림 ${fig.index + 1}/${figures.length} 캡션${caption ? " 생성" : " 건너뜀"}`);

    store.addFigure(sourceId, fig.publicPath, targetPageId, caption, fig.pageNumber);

    const alt = caption || `Figure ${fig.index + 1}`;
    const captionLine = caption ? `\n*${caption}*` : "";
    blocks.push(`![${alt}](${fig.publicPath})${captionLine}`);
  }

  if (targetPageId != null && blocks.length > 0) {
    const page = store.getPageById(targetPageId);
    if (page && !page.content.includes("<!-- figures -->")) {
      const section = `\n\n<!-- figures -->\n## Figures\n\n${blocks.join("\n\n")}\n`;
      store.updatePageContent(targetPageId, page.content + section);
    }
  }

  return { figureCount: figures.length, captionedCount };
}

/**
 * Full figure stage: extract from a PDF, caption via vision, and embed.
 * No-ops (graceful skip) for non-PDF sources or when extraction yields nothing.
 */
export async function runFigureStage(opts: {
  store: Store;
  client: LLMClient;
  sourceId: number;
  ext: string;
  filePath: string;
  uploadsFiguresDir: string;
  onProgress?: (status: string) => void;
  extractor?: (pdfPath: string, outDir: string, sourceId: number) => Promise<ExtractedFigure[]>;
  captioner?: Captioner;
}): Promise<AttachFiguresResult> {
  const { store, client, sourceId, ext, filePath, uploadsFiguresDir, onProgress } = opts;
  if (ext !== "pdf") return { figureCount: 0, captionedCount: 0 };

  const extractor = opts.extractor ?? extractFiguresFromPdf;
  const captioner = opts.captioner ?? makeVisionCaptioner(client);

  onProgress?.("⏳ 그림 추출 중...");
  const figures = await extractor(filePath, uploadsFiguresDir, sourceId);
  if (figures.length === 0) {
    onProgress?.("그림 없음 (또는 추출 도구 미설치) — 건너뜀");
    return { figureCount: 0, captionedCount: 0 };
  }

  if (!client.supportsVision()) {
    onProgress?.(`⚠ ${figures.length}개 그림 추출됨, vision 미지원 — 캡션 없이 임베드`);
  }

  return attachFigures({ store, sourceId, figures, captioner, onProgress });
}
