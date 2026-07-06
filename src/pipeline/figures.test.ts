import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Store } from "../store";
import { attachFigures, runFigureStage, type ExtractedFigure, type Captioner } from "./figures";

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

  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
  });
  afterEach(() => store.close());

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

  test("re-running is idempotent — figures are not duplicated", async () => {
    const src = store.addSource("file:///doc.pdf", "pdf", "Doc", "(file)");
    store.addPage("doc", "Doc", "# Doc", src.id, undefined, "source", 0);
    const captioner: Captioner = async () => "c";

    await attachFigures({ store, sourceId: src.id, figures: [fig(0), fig(1)], captioner });
    await attachFigures({ store, sourceId: src.id, figures: [fig(0)], captioner });

    expect(store.listFiguresBySource(src.id)).toHaveLength(1);
  });

  test("empty figure list is a no-op", async () => {
    const src = store.addSource("file:///doc.pdf", "pdf", "Doc", "(file)");
    const res = await attachFigures({ store, sourceId: src.id, figures: [], captioner: async () => "c" });
    expect(res).toEqual({ figureCount: 0, captionedCount: 0 });
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
