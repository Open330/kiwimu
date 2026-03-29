import { mkdirSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { loadConfig, type KiwiConfig } from "../config";
import type { Store } from "../store";
import { buildGraphData } from "../pipeline/graph";
import { renderPage, renderIndex, renderGraph, renderQuizPage } from "./templates";

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
      pageId: page.id,
      origin: page.origin,
      content: body,
      externalRefs,
      toc,
      backlinks,
      sourcePages: sourcePages.map((p) => ({ slug: p.slug, title: p.title })),
      conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title, origin: p.origin })),
    });

    await Bun.write(join(wikiDir, `${page.slug}.html`), html);
  }

  const indexHtml = renderIndex({
    wikiName,
    sourcePages: sourcePages.map((p) => ({ slug: p.slug, title: p.title })),
    conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title })),
    sourceCount: store.countSources(),
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

  // Quiz page
  const quizzes = store.getAllQuizzes();
  await Bun.write(
    join(outputDir, "quiz.html"),
    renderQuizPage({
      wikiName,
      quizzes: quizzes.map((q) => ({
        id: q.id,
        question: q.question,
        answer: q.answer,
        explanation: q.explanation || "",
        quiz_type: q.quiz_type,
        page_title: q.page_title,
        page_slug: q.page_slug,
      })),
      sourcePages: sourcePages.map((p) => ({ slug: p.slug, title: p.title })),
      conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title })),
    })
  );

  // Random page redirect
  mkdirSync(join(wikiDir), { recursive: true });
  await Bun.write(
    join(wikiDir, "random.html"),
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>임의 문서</title></head><body><script>
fetch('/search-index.json').then(r=>r.json()).then(pages=>{
  const p = pages[Math.floor(Math.random()*pages.length)];
  if(p) location.href='/wiki/'+p.slug+'.html';
  else location.href='/';
});
</script></body></html>`
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

export async function buildSinglePage(root: string, store: Store, slug: string): Promise<void> {
  const page = store.getPage(slug);
  if (!page) return;

  const config = loadConfig(root);
  const siteDir = join(root, config.build?.output_dir || "_site");
  const wikiDir = join(siteDir, "wiki");
  mkdirSync(wikiDir, { recursive: true });

  const sourcePages = store.listSourcePages();
  const conceptPages = store.listConceptPages();
  const wikiName = config.project.name;
  const backlinksMap = store.getAllBacklinksGrouped();

  // Render the single page (same logic as buildSite loop)
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
    pageId: page.id,
    origin: page.origin,
    content: body,
    externalRefs,
    toc,
    backlinks,
    sourcePages: sourcePages.map((p) => ({ slug: p.slug, title: p.title })),
    conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title, origin: p.origin })),
  });

  await Bun.write(join(wikiDir, `${page.slug}.html`), html);

  // Update search-index.json
  const searchIndexPath = join(siteDir, "search-index.json");
  let searchData: Array<{ slug: string; title: string; preview: string; type: string }> = [];
  if (existsSync(searchIndexPath)) {
    try {
      searchData = JSON.parse(readFileSync(searchIndexPath, "utf-8"));
    } catch {
      searchData = [];
    }
  }
  // Remove existing entry for this slug if any
  searchData = searchData.filter((p) => p.slug !== page.slug);
  // Append new entry
  searchData.push({
    slug: page.slug,
    title: page.title,
    preview: page.content.slice(0, 200),
    type: page.page_type,
  });
  await Bun.write(searchIndexPath, JSON.stringify(searchData));
}
