import { expect, test, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../store";
import {
  attachFigures,
  captureFigureState,
  extractFiguresFromPdf,
  MAX_EXTRACTED_PDF_FIGURE_BYTES,
  MAX_EXTRACTED_PDF_FIGURES,
  runFigureStage,
  type ExtractedFigure,
  type Captioner,
} from "./figures";

function fig(index: number, page: number | null = 1): ExtractedFigure {
  return {
    filePath: `/tmp/figs/src1-${index}.png`,
    publicPath: `/static/figures/src1-${index}.png`,
    pageNumber: page,
    index,
  };
}

describe("figures pipeline", () => {
  let store: Store;
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
  });
  afterEach(() => {
    store.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("attachFigures persists rows and embeds a Figures section into the source page", async () => {
    const src = store.addSource("file:///doc.pdf", "pdf", "Doc", "(file)");
    store.addPage("doc", "Doc", "# Doc\n\nBody.", src.id, undefined, "source", 0);

    const captioner: Captioner = async (f) => `caption ${f.index}`;
    const res = await attachFigures({ store, sourceId: src.id, figures: [fig(0), fig(1)], captioner });

    expect(res.figureCount).toBe(2);
    expect(res.captionedCount).toBe(2);

    const rows = store.listFiguresBySource(src.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].caption).toBe("caption 0");

    const page = store.getSourcePages(src.id)[0];
    expect(page.content).toContain("## Figures");
    expect(page.content).toContain("/static/figures/src1-0.png");
    expect(page.content).toContain("*caption 1*");
  });

  test("null captions still embed images (graceful no-vision path)", async () => {
    const src = store.addSource("file:///doc.pdf", "pdf", "Doc", "(file)");
    store.addPage("doc", "Doc", "# Doc", src.id, undefined, "source", 0);

    const captioner: Captioner = async () => null;
    const res = await attachFigures({ store, sourceId: src.id, figures: [fig(0)], captioner });

    expect(res.figureCount).toBe(1);
    expect(res.captionedCount).toBe(0);
    const page = store.getSourcePages(src.id)[0];
    expect(page.content).toContain("/static/figures/src1-0.png");
  });

  test("re-running with fewer figures replaces rows and the generated section", async () => {
    const src = store.addSource("file:///doc.pdf", "pdf", "Doc", "(file)");
    store.addPage("doc", "Doc", "# Doc", src.id, undefined, "source", 0);
    const captioner: Captioner = async () => "c";

    await attachFigures({ store, sourceId: src.id, figures: [fig(0), fig(1)], captioner });
    await attachFigures({ store, sourceId: src.id, figures: [fig(2)], captioner });

    expect(store.listFiguresBySource(src.id)).toHaveLength(1);
    const content = store.getSourcePages(src.id)[0].content;
    expect(content.match(/<!-- figures -->/g)).toHaveLength(1);
    expect(content).toContain("/static/figures/src1-2.png");
    expect(content).not.toContain("/static/figures/src1-0.png");
    expect(content).not.toContain("/static/figures/src1-1.png");
  });

  test("empty figure list preserves existing rows and generated content", async () => {
    const src = store.addSource("file:///doc.pdf", "pdf", "Doc", "(file)");
    store.addPage("doc", "Doc", "# Doc", src.id, undefined, "source", 0);
    await attachFigures({ store, sourceId: src.id, figures: [fig(0)], captioner: async () => "existing" });

    const res = await attachFigures({ store, sourceId: src.id, figures: [], captioner: async () => "c" });

    expect(res).toEqual({ figureCount: 0, captionedCount: 0 });
    expect(store.listFiguresBySource(src.id)).toHaveLength(1);
    expect(store.getSourcePages(src.id)[0].content).toContain("/static/figures/src1-0.png");
  });

  test("fresh re-ingest restores the previous figure state when extraction returns empty", async () => {
    const src = store.addSource("file:///doc.pdf", "pdf", "Doc", "(file)");
    store.addPage("old-doc", "Old Doc", "# Old Doc", src.id, undefined, "source", 0);
    await attachFigures({ store, sourceId: src.id, figures: [fig(0)], captioner: async () => "existing" });
    const preservedState = captureFigureState(store, src.id);

    // Mirrors ingestFile's fresh-attempt lifecycle: partial/source-owned state is
    // cleared before the regenerated page exists, then the figure tool runs.
    store.deletePagesBySource(src.id);
    store.addPage("new-doc", "New Doc", "# New Doc", src.id, undefined, "source", 0);
    const result = await runFigureStage({
      store,
      client: { supportsVision: () => false } as any,
      sourceId: src.id,
      ext: "pdf",
      filePath: "/tmp/doc.pdf",
      uploadsFiguresDir: "/tmp/figs",
      extractor: async () => [],
      preservedState,
    });

    expect(result).toEqual({ figureCount: 0, captionedCount: 0 });
    expect(store.listFiguresBySource(src.id)).toHaveLength(1);
    expect(store.listFiguresBySource(src.id)[0].image_path).toBe("/static/figures/src1-0.png");
    expect(store.getSourcePages(src.id)[0].content).toContain("/static/figures/src1-0.png");
  });

  test("extractFiguresFromPdf publishes only the current staged result", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figures-"));
    temporaryDirectories.push(root);
    const outputRoot = join(root, "figures");
    let run = 0;
    const stagingDirectories: string[] = [];
    const stagingModes: number[] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation(((command: any) => {
      run++;
      const prefixPath = command.at(-1) as string;
      stagingDirectories.push(dirname(prefixPath));
      stagingModes.push(statSync(dirname(prefixPath)).mode & 0o777);
      writeFileSync(`${prefixPath}-001-000.png`, `run-${run}`);
      if (run === 1) writeFileSync(`${prefixPath}-002-001.png`, "old-extra");
      return { exited: Promise.resolve(0) } as any;
    }) as any);

    try {
      const first = await extractFiguresFromPdf("/tmp/doc.pdf", outputRoot, 1);
      const second = await extractFiguresFromPdf("/tmp/doc.pdf", outputRoot, 1);

      expect(first).toHaveLength(2);
      expect(second.map((figure) => figure.publicPath)).toEqual([
        "/static/figures/src1-001-000.png",
      ]);
      expect(second[0].pageNumber).toBe(1);
      expect(stagingDirectories.every((directory) => !existsSync(directory))).toBe(true);
      expect(readdirSync(root)).toEqual(["figures"]);
      if (process.platform !== "win32") {
        expect(stagingModes).toEqual([0o700, 0o700]);
        expect(statSync(outputRoot).mode & 0o777).toBe(0o700);
        expect(statSync(second[0].filePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      spawn.mockRestore();
    }
  });

  test("extractFiguresFromPdf removes staging after an extraction error", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figures-error-"));
    temporaryDirectories.push(root);
    const outputRoot = join(root, "figures");
    let stagingDirectory = "";
    const spawn = spyOn(Bun, "spawn").mockImplementation(((command: any) => {
      const prefixPath = command.at(-1) as string;
      stagingDirectory = dirname(prefixPath);
      writeFileSync(`${prefixPath}-001-000.png`, "partial");
      throw new Error("pdfimages failed to start");
    }) as any);

    try {
      expect(await extractFiguresFromPdf("/tmp/doc.pdf", outputRoot, 1)).toEqual([]);
      expect(stagingDirectory).not.toBe("");
      expect(existsSync(stagingDirectory)).toBe(false);
      expect(readdirSync(outputRoot)).toEqual([]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("extractFiguresFromPdf rejects and cleans output over the figure-count cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figures-count-limit-"));
    temporaryDirectories.push(root);
    const outputRoot = join(root, "figures");
    let stagingDirectory = "";
    const spawn = spyOn(Bun, "spawn").mockImplementation(((command: any) => {
      const prefixPath = command.at(-1) as string;
      stagingDirectory = dirname(prefixPath);
      for (let index = 0; index <= MAX_EXTRACTED_PDF_FIGURES; index++) {
        writeFileSync(`${prefixPath}-001-${index.toString().padStart(3, "0")}.png`, "x");
      }
      return { exited: Promise.resolve(0) } as any;
    }) as any);

    try {
      await expect(extractFiguresFromPdf("/tmp/doc.pdf", outputRoot, 1)).rejects.toThrow(
        "PDF figure extraction exceeded the limit",
      );
      expect(existsSync(stagingDirectory)).toBeFalse();
      expect(readdirSync(outputRoot)).toEqual([]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("extractFiguresFromPdf rejects and cleans output over the aggregate-byte cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwimu-figures-byte-limit-"));
    temporaryDirectories.push(root);
    const outputRoot = join(root, "figures");
    let stagingDirectory = "";
    const spawn = spyOn(Bun, "spawn").mockImplementation(((command: any) => {
      const prefixPath = command.at(-1) as string;
      stagingDirectory = dirname(prefixPath);
      const oversized = `${prefixPath}-001-000.png`;
      writeFileSync(oversized, "");
      truncateSync(oversized, MAX_EXTRACTED_PDF_FIGURE_BYTES + 1);
      return { exited: Promise.resolve(0) } as any;
    }) as any);

    try {
      await expect(extractFiguresFromPdf("/tmp/doc.pdf", outputRoot, 1)).rejects.toThrow(
        "PDF figure extraction exceeded the limit",
      );
      expect(existsSync(stagingDirectory)).toBeFalse();
      expect(readdirSync(outputRoot)).toEqual([]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("runFigureStage skips non-PDF sources", async () => {
    const src = store.addSource("file:///doc.md", "md", "Doc", "(file)");
    const client = { supportsVision: () => false } as any;
    const res = await runFigureStage({
      store, client, sourceId: src.id, ext: "md",
      filePath: "/tmp/doc.md", uploadsFiguresDir: "/tmp/figs",
    });
    expect(res).toEqual({ figureCount: 0, captionedCount: 0 });
  });

  test("runFigureStage with an injected extractor extracts + embeds", async () => {
    const src = store.addSource("file:///doc.pdf", "pdf", "Doc", "(file)");
    store.addPage("doc", "Doc", "# Doc", src.id, undefined, "source", 0);
    const client = { supportsVision: () => false } as any;

    const res = await runFigureStage({
      store, client, sourceId: src.id, ext: "pdf",
      filePath: "/tmp/doc.pdf", uploadsFiguresDir: "/tmp/figs",
      extractor: async () => [fig(0), fig(1)],
      captioner: async () => null,
    });

    expect(res.figureCount).toBe(2);
    expect(store.listFiguresBySource(src.id)).toHaveLength(2);
  });

  test("runFigureStage no-ops when the extractor finds nothing", async () => {
    const src = store.addSource("file:///doc.pdf", "pdf", "Doc", "(file)");
    const client = { supportsVision: () => true } as any;
    const res = await runFigureStage({
      store, client, sourceId: src.id, ext: "pdf",
      filePath: "/tmp/doc.pdf", uploadsFiguresDir: "/tmp/figs",
      extractor: async () => [],
    });
    expect(res.figureCount).toBe(0);
  });
});
