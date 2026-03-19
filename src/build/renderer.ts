import { mkdirSync, rmSync, cpSync, existsSync } from "fs";
import { join, dirname } from "path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { KiwiConfig } from "../config";
import type { Store } from "../store";
import { buildGraphData } from "../pipeline/graph";
import { renderPage, renderIndex, renderGraph } from "./templates";

// Fix internal wiki links: /wiki/slug → /wiki/slug.html
function fixWikiLinks(html: string): string {
  return html.replace(/href="\/wiki\/([^"]+?)"/g, (match, slug) => {
    if (slug.endsWith(".html")) return match;
    return `href="/wiki/${slug}.html"`;
  });
}

// Separate external reference links from body content
function extractExternalRefs(html: string): { body: string; externalRefs: string } {
  const marker = '<h2 id="external-references">External References</h2>';
  const idx = html.indexOf(marker);
  if (idx === -1) return { body: html, externalRefs: "" };

  const body = html.slice(0, idx);
  const refSection = html.slice(idx + marker.length);
  return { body, externalRefs: refSection };
}

function generateToc(markdown: string): string {
  const headings: Array<{ level: number; text: string; id: string }> = [];
  const headingRegex = /^(#{2,4})\s+(.+)$/gm;
  let match;
  while ((match = headingRegex.exec(markdown)) !== null) {
    const text = match[2].trim();
    if (text === "External References") continue;
    const id = text.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
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

  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  mkdirSync(staticDir, { recursive: true });

  const assetsDir = join(dirname(import.meta.path), "static");
  if (existsSync(assetsDir)) {
    cpSync(assetsDir, staticDir, { recursive: true });
  }

  // Copy logo
  const logoSrc = join(projectRoot, "..", "assets", "logos", "logo_2_minimalist_icon_transparent.png");
  const logoSrc2 = join(projectRoot, "assets", "logos", "logo_2_minimalist_icon_transparent.png");
  const logoFile = existsSync(logoSrc) ? logoSrc : existsSync(logoSrc2) ? logoSrc2 : null;
  if (logoFile) {
    cpSync(logoFile, join(staticDir, "logo.png"));
  }

  const pages = store.listPages();
  const sourcePages = store.listSourcePages();
  const conceptPages = store.listConceptPages();
  const wikiName = config.project.name;
  const backlinksMap = store.getAllBacklinksGrouped();

  for (const page of pages) {
    let htmlContent = await marked(page.content);
    htmlContent = sanitizeHtml(htmlContent, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat([
        'img', 'details', 'summary', 'kbd', 'del', 's', 'sup', 'sub',
        'span', 'div', 'section', 'figure', 'figcaption', 'mark'
      ]),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        '*': ['id', 'class', 'style'],
        'img': ['src', 'alt', 'title', 'width', 'height'],
        'a': ['href', 'title', 'target', 'rel'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
    });
    htmlContent = fixWikiLinks(htmlContent);

    const { body, externalRefs } = extractExternalRefs(htmlContent);
    const toc = generateToc(page.content);
    const backlinks = (backlinksMap.get(page.id) || []).map((bl) => ({
      slug: bl.slug,
      title: bl.title,
      pageType: bl.page_type,
    }));

    const html = renderPage({
      wikiName,
      pageTitle: page.title,
      pageSlug: page.slug,
      pageType: page.page_type,
      content: body,
      externalRefs,
      toc,
      backlinks,
      sourcePages: sourcePages.map((p) => ({ slug: p.slug, title: p.title })),
      conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title })),
    });

    await Bun.write(join(wikiDir, `${page.slug}.html`), html);
  }

  const indexHtml = renderIndex({
    wikiName,
    sourcePages: sourcePages.map((p) => ({ slug: p.slug, title: p.title })),
    conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title })),
    sourceCount: store.listSources().length,
  });
  await Bun.write(join(outputDir, "index.html"), indexHtml);

  const graphData = buildGraphData(store);
  await Bun.write(join(outputDir, "graph-data.json"), JSON.stringify(graphData));
  await Bun.write(
    join(outputDir, "graph.html"),
    renderGraph({
      wikiName,
      sourcePages: sourcePages.map((p) => ({ slug: p.slug, title: p.title })),
      conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title })),
    })
  );

  const searchData = pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    preview: p.content.slice(0, 200),
    type: p.page_type,
  }));
  await Bun.write(join(outputDir, "search-index.json"), JSON.stringify(searchData));

  return pages.length;
}
