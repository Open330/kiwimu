/**
 * Figure/diagram extraction pipeline stage.
 *
 * Extracts images from PDFs, captions them via a multimodal LLM (vision), and
 * embeds them into wiki source pages. Every external dependency (the image
 * extraction tool and the captioner) is injectable so the core embedding logic
 * (`attachFigures`) is unit-testable without a real PDF or a live vision call.
 */
import type { LLMClient } from "../llm-client";
import type { Figure, Store } from "../store";
import { abortReason, awaitWithAbort, throwIfAborted } from "../abort";
import { GENERATION_FIGURE_PREFIX_PATTERN } from "../services/figure-maintenance";

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

export const MAX_EXTRACTED_PDF_FIGURES = 128;
export const MAX_EXTRACTED_PDF_FIGURE_BYTES = 64 * 1024 * 1024;
const FIGURE_BUDGET_POLL_MS = 100;

export class PdfFigureExtractionLimitError extends Error {
  constructor(count: number, bytes: number) {
    super(
      `PDF figure extraction exceeded the limit (${count}/${MAX_EXTRACTED_PDF_FIGURES} files, ${bytes}/${MAX_EXTRACTED_PDF_FIGURE_BYTES} bytes)`,
    );
    this.name = "PdfFigureExtractionLimitError";
  }
}

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
  sourceId: number,
  filePrefix?: string,
  signal?: AbortSignal,
): Promise<ExtractedFigure[]> {
  const { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } = await import("fs");
  const { dirname, join, resolve } = await import("path");
  const outputRoot = resolve(outDir);
  const prefix = filePrefix ?? `src${sourceId}`;
  if (!GENERATION_FIGURE_PREFIX_PATTERN.test(prefix)) {
    throw new TypeError("Unsafe figure filename prefix");
  }
  let stagingDir: string | null = null;
  let processHandle: ReturnType<typeof Bun.spawn> | null = null;

  try {
    throwIfAborted(signal);
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    chmodSync(outputRoot, 0o700);

    // Keep extraction output outside the live figures root. A sibling staging
    // directory guarantees rename-based publication stays on one filesystem.
    stagingDir = mkdtempSync(join(dirname(outputRoot), `.figures-src${sourceId}-`));
    chmodSync(stagingDir, 0o700);

    const proc = Bun.spawn(["pdfimages", "-png", "-p", pdfPath, join(stagingDir, prefix)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    processHandle = proc;
    const kill = () => {
      try {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      } catch {}
    };
    signal?.addEventListener("abort", kill, { once: true });
    let extractionRunning = true;
    let limitError: PdfFigureExtractionLimitError | null = null;
    const assertWithinBudget = (): void => {
      let count = 0;
      let bytes = 0;
      for (const entry of readdirSync(stagingDir!)) {
        const stat = lstatSync(join(stagingDir!, entry));
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Unsafe PDF figure extraction output: ${entry}`);
        }
        count++;
        bytes += stat.size;
        if (count > MAX_EXTRACTED_PDF_FIGURES || bytes > MAX_EXTRACTED_PDF_FIGURE_BYTES) {
          throw new PdfFigureExtractionLimitError(count, bytes);
        }
      }
    };
    const budgetMonitor = (async () => {
      while (extractionRunning) {
        await Bun.sleep(FIGURE_BUDGET_POLL_MS);
        if (!extractionRunning) break;
        try {
          assertWithinBudget();
        } catch (error) {
          if (!(error instanceof PdfFigureExtractionLimitError)) throw error;
          limitError = error;
          try { proc.kill("SIGKILL"); } catch {}
          break;
        }
      }
    })();
    let code: number;
    try {
      code = await awaitWithAbort(proc.exited, signal);
    } finally {
      extractionRunning = false;
      signal?.removeEventListener("abort", kill);
      await budgetMonitor;
    }
    if (limitError) throw limitError;
    if (code !== 0) return [];
    throwIfAborted(signal);
    assertWithinBudget();

    const files = readdirSync(stagingDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith(".png"))
      .map((entry) => entry.name)
      .sort();

    for (const file of files) {
      const stagedPath = join(stagingDir, file);
      const publishedPath = join(outputRoot, file);
      chmodSync(stagedPath, 0o600);
      renameSync(stagedPath, publishedPath);
      chmodSync(publishedPath, 0o600);
    }

    return files.map((file, index) => {
      // pdfimages -p names files "<prefix>-<page>-<num>.png"
      const match = file.match(/-(\d+)-\d+\.png$/);
      return {
        filePath: join(outputRoot, file),
        publicPath: `/static/figures/${file}`,
        pageNumber: match ? parseInt(match[1], 10) : null,
        index,
      };
    });
  } catch (error) {
    if (signal?.aborted) {
      if (processHandle) await Promise.allSettled([processHandle.exited]);
      throw abortReason(signal);
    }
    if (error instanceof PdfFigureExtractionLimitError) throw error;
    // pdfimages not installed → graceful skip
    return [];
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
}

export interface AttachFiguresResult {
  figureCount: number;
  captionedCount: number;
}

const FIGURES_SECTION_START = "<!-- figures -->";
const FIGURES_SECTION_END = "<!-- /figures -->";

export interface FigureStateSnapshot {
  figures: Array<Pick<Figure, "image_path" | "caption" | "page_number">>;
  section: string | null;
}

function extractFiguresSection(content: string): string | null {
  const start = content.indexOf(FIGURES_SECTION_START);
  if (start < 0) return null;
  const endStart = content.indexOf(FIGURES_SECTION_END, start + FIGURES_SECTION_START.length);
  return endStart < 0
    ? content.slice(start).trim()
    : content.slice(start, endStart + FIGURES_SECTION_END.length).trim();
}

/** Capture the last successful figure rows/section before fresh re-ingest deletes source pages. */
export function captureFigureState(store: Store, sourceId: number): FigureStateSnapshot {
  const figures = store.listFiguresBySource(sourceId).map((figure) => ({
    image_path: figure.image_path,
    caption: figure.caption,
    page_number: figure.page_number,
  }));
  const section = store.getSourcePages(sourceId)
    .map((page) => extractFiguresSection(page.content))
    .find((value): value is string => value !== null) ?? null;
  return { figures, section };
}

/** Restore a captured non-empty state when the extractor is temporarily unavailable. */
export function restoreFigureState(store: Store, sourceId: number, snapshot?: FigureStateSnapshot): void {
  if (!snapshot || snapshot.figures.length === 0 || store.listFiguresBySource(sourceId).length > 0) return;

  const targetPage = store.getSourcePages(sourceId)[0] ?? null;
  for (const figure of snapshot.figures) {
    store.addFigure(
      sourceId,
      figure.image_path,
      targetPage?.id ?? null,
      figure.caption,
      figure.page_number,
    );
  }
  if (targetPage && snapshot.section && !targetPage.content.includes(FIGURES_SECTION_START)) {
    store.updatePageContent(targetPage.id, `${targetPage.content.trimEnd()}\n\n${snapshot.section}\n`);
  }
}

function replaceFiguresSection(content: string, blocks: string[]): string {
  const section = `${FIGURES_SECTION_START}\n## Figures\n\n${blocks.join("\n\n")}\n${FIGURES_SECTION_END}`;
  const start = content.indexOf(FIGURES_SECTION_START);
  if (start < 0) return `${content.trimEnd()}\n\n${section}\n`;

  const endStart = content.indexOf(FIGURES_SECTION_END, start + FIGURES_SECTION_START.length);
  const suffix = endStart < 0
    ? ""
    : content.slice(endStart + FIGURES_SECTION_END.length).trimStart();
  const prefix = content.slice(0, start).trimEnd();
  return [prefix, section, suffix].filter(Boolean).join("\n\n") + "\n";
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
  signal?: AbortSignal;
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
    throwIfAborted(opts.signal);
    let caption: string | null = null;
    try {
      caption = await captioner(fig);
    } catch {
      throwIfAborted(opts.signal);
      caption = null;
    }
    throwIfAborted(opts.signal);
    if (caption) captionedCount++;
    onProgress?.(`그림 ${fig.index + 1}/${figures.length} 캡션${caption ? " 생성" : " 건너뜀"}`);

    store.addFigure(sourceId, fig.publicPath, targetPageId, caption, fig.pageNumber);

    const alt = caption || `Figure ${fig.index + 1}`;
    const captionLine = caption ? `\n*${caption}*` : "";
    blocks.push(`![${alt}](${fig.publicPath})${captionLine}`);
  }

  if (targetPageId != null && blocks.length > 0) {
    const page = store.getPageById(targetPageId);
    if (page) {
      store.updatePageContent(targetPageId, replaceFiguresSection(page.content, blocks));
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
  extractor?: (
    pdfPath: string,
    outDir: string,
    sourceId: number,
    filePrefix?: string,
    signal?: AbortSignal,
  ) => Promise<ExtractedFigure[]>;
  captioner?: Captioner;
  preservedState?: FigureStateSnapshot;
  /** Unique generation prefix; keeps unpublished files from replacing live figures. */
  filePrefix?: string;
  signal?: AbortSignal;
}): Promise<AttachFiguresResult> {
  const { store, client, sourceId, ext, filePath, uploadsFiguresDir, onProgress } = opts;
  if (ext !== "pdf") return { figureCount: 0, captionedCount: 0 };

  const extractor = opts.extractor ?? extractFiguresFromPdf;
  const captioner = opts.captioner ?? makeVisionCaptioner(client);

  onProgress?.("⏳ 그림 추출 중...");
  throwIfAborted(opts.signal);
  const figures = await extractor(filePath, uploadsFiguresDir, sourceId, opts.filePrefix, opts.signal);
  if (figures.length === 0) {
    restoreFigureState(store, sourceId, opts.preservedState);
    onProgress?.("그림 없음 (또는 추출 도구 미설치) — 건너뜀");
    return { figureCount: 0, captionedCount: 0 };
  }

  if (!client.supportsVision()) {
    onProgress?.(`⚠ ${figures.length}개 그림 추출됨, vision 미지원 — 캡션 없이 임베드`);
  }

  return attachFigures({ store, sourceId, figures, captioner, onProgress, signal: opts.signal });
}
