import { mkdirSync, rmSync, cpSync, existsSync } from "fs";
import { join, dirname } from "path";
import { marked } from "marked";
import type { KiwiConfig } from "../config";
import type { Store } from "../store";
import { buildGraphData } from "../pipeline/graph";
import { renderPage, renderIndex, renderGraph } from "./templates";

// Generate TOC from headings in markdown
function generateToc(markdown: string): string {
  const headings: Array<{ level: number; text: string; id: string }> = [];
  const headingRegex = /^(#{2,4})\s+(.+)$/gm;
  let match;
  while ((match = headingRegex.exec(markdown)) !== null) {
    const text = match[2].trim();
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");
    headings.push({ level: match[1].length, text, id });
  }
  if (!headings.length) return "";

  return `<div class="toc"><ul>${headings
    .map((h) => `<li style="margin-left:${(h.level - 2) * 16}px"><a href="#${h.id}">${h.text}</a></li>`)
    .join("")}</ul></div>`;
}

export async function buildSite(store: Store, config: KiwiConfig, projectRoot: string): Promise<number> {
  const outputDir = join(projectRoot, config.build.output_dir);
  const wikiDir = join(outputDir, "wiki");
  const staticDir = join(outputDir, "static");

  // Clean and recreate
  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  mkdirSync(staticDir, { recursive: true });

  // Copy static assets
  const assetsDir = join(dirname(import.meta.path), "static");
  if (existsSync(assetsDir)) {
    cpSync(assetsDir, staticDir, { recursive: true });
  }

  const pages = store.listPages();
  const pageList = pages.map((p) => ({ slug: p.slug, title: p.title }));
  const wikiName = config.project.name;

  // Render pages
  for (const page of pages) {
    const htmlContent = await marked(page.content);
    const toc = generateToc(page.content);
    const backlinks = store.getBacklinks(page.id).map((bl) => ({ slug: bl.slug, title: bl.title }));

    const html = renderPage({
      wikiName,
      pageTitle: page.title,
      pageSlug: page.slug,
      content: htmlContent,
      toc,
      backlinks,
      allPages: pageList,
    });

    await Bun.write(join(wikiDir, `${page.slug}.html`), html);
  }

  // Render index
  const indexHtml = renderIndex({
    wikiName,
    allPages: pageList,
    pageCount: pages.length,
    sourceCount: store.listSources().length,
  });
  await Bun.write(join(outputDir, "index.html"), indexHtml);

  // Render graph
  const graphData = buildGraphData(store);
  await Bun.write(join(outputDir, "graph-data.json"), JSON.stringify(graphData));
  await Bun.write(join(outputDir, "graph.html"), renderGraph({ wikiName, allPages: pageList }));

  // Search index
  const searchData = pages.map((p) => ({ slug: p.slug, title: p.title, preview: p.content.slice(0, 200) }));
  await Bun.write(join(outputDir, "search-index.json"), JSON.stringify(searchData));

  return pages.length;
}
