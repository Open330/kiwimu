import { mkdirSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { loadConfig, type KiwiConfig } from "../config";
import type { Store } from "../store";
import { buildGraphData } from "../pipeline/graph";
import { renderCitationFootnotes } from "../pipeline/citations";
import { renderPage, renderIndex, renderGraph, renderQuizPage, renderDashboardPage, renderCatalogPage } from "./templates";

function escapeHtmlChars(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Fallback: catches any ```mermaid block that slipped past the placeholder pre-pass.
// Keeps marked's existing escaping intact — the browser decodes via textContent
// when mermaid.js reads the diagram source.
function convertMermaidBlocks(html: string): string {
  if (!html.includes('language-mermaid')) return html;
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_match, code: string) => {
      if (!code.trim()) return '';
      return `<pre class="mermaid">${code}</pre>`;
    }
  );
}

// Fix internal wiki links: /wiki/slug → /wiki/slug.html
// Mark non-existent pages as "red links" (wiki convention for missing pages)
function fixWikiLinks(html: string, existingSlugs?: Set<string>): string {
  return html.replace(/href="\/wiki\/([^"]+?)"/g, (match, slug) => {
    const cleanSlug = slug.endsWith(".html") ? slug.replace(".html", "") : slug;
    const decodedSlug = decodeURIComponent(cleanSlug);
    const href = slug.endsWith(".html") ? match : `href="/wiki/${slug}.html"`;

    // If we have slug list and this page doesn't exist, mark as red link
    if (existingSlugs && !existingSlugs.has(decodedSlug) && !existingSlugs.has(cleanSlug)) {
      return `${href} class="redlink" title="문서 없음: ${decodedSlug}"`;
    }
    return href;
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

// Shared markdown rendering + sanitization logic
export async function renderPageContent(page: { content: string }, existingSlugs?: Set<string>): Promise<string> {
  // Convert [[wiki links]] to markdown links before rendering
  // [[slug]] → [slug](/wiki/slug.html)
  // [[slug|display text]] → [display text](/wiki/slug.html)
  let markdown = page.content.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_match, slug, display) => {
    const text = display || slug.replace(/-/g, ' ');
    return `[${text}](/wiki/${encodeURIComponent(slug)}.html)`;
  });

  // Protect LaTeX math from marked() processing
  // Replace $...$ and $$...$$ with placeholders to prevent _ and * from being parsed as markdown
  const mathPlaceholders: string[] = [];
  markdown = markdown.replace(/\$\$[\s\S]+?\$\$/g, (match) => {
    mathPlaceholders.push(match);
    return `%%MATH_BLOCK_${mathPlaceholders.length - 1}%%`;
  });
  markdown = markdown.replace(/\$(?!\$)(.+?)\$/g, (match) => {
    mathPlaceholders.push(match);
    return `%%MATH_INLINE_${mathPlaceholders.length - 1}%%`;
  });

  // Protect mermaid fenced blocks: extract verbatim before marked sees them, so
  // node labels containing markdown chars (*, _, |) or HTML chars (<, >, ")
  // never get mangled by marked or stripped by sanitize-html.
  const mermaidBlocks: string[] = [];
  markdown = markdown.replace(/```mermaid\r?\n([\s\S]*?)```/g, (_match, body: string) => {
    mermaidBlocks.push(body);
    return `\n\n%%MERMAID_BLOCK_${mermaidBlocks.length - 1}%%\n\n`;
  });

  let htmlContent = await marked(markdown);

  // Restore LaTeX math from placeholders
  htmlContent = htmlContent.replace(/%%MATH_(BLOCK|INLINE)_(\d+)%%/g, (_match, _type, idx) => {
    return mathPlaceholders[parseInt(idx)] || '';
  });
  // Fallback: convert any leftover marked-emitted mermaid code blocks
  htmlContent = convertMermaidBlocks(htmlContent);
  htmlContent = sanitizeHtml(htmlContent, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'details', 'summary', 'kbd', 'del', 's', 'sup', 'sub',
      'span', 'div', 'section', 'figure', 'figcaption', 'mark',
      'pre', 'code'
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      '*': ['id', 'class'],
      'img': ['src', 'alt', 'title', 'width', 'height'],
      'a': ['href', 'title', 'target', 'rel'],
      'span': ['class'],  // For KaTeX
      'pre': ['class'],   // For Mermaid
      'code': ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  });

  // Restore mermaid blocks AFTER sanitize so the diagram source is preserved
  // verbatim. Escape only the HTML structural chars so the browser's textContent
  // (which mermaid.js uses) yields the original characters.
  htmlContent = htmlContent.replace(
    /(?:<p>\s*)?%%MERMAID_BLOCK_(\d+)%%(?:\s*<\/p>)?/g,
    (_match, idx) => {
      const body = mermaidBlocks[parseInt(idx, 10)] || '';
      if (!body.trim()) return '';
      return `<pre class="mermaid">${escapeHtmlChars(body)}</pre>`;
    }
  );

  htmlContent = fixWikiLinks(htmlContent, existingSlugs);
  return htmlContent;
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

  // Copy logo (check multiple possible locations).
  // Order: shipped-with-kiwimu (works for both git clone and npm install), then
  // wiki-project-local overrides, then Docker path, then the assetsDir copy
  // already produced above (so Bun.file lookups stay consistent).
  const kiwimuAssets = join(dirname(import.meta.path), "..", "..", "assets", "logos", "logo_2_minimalist_icon_transparent.png");
  const logoCandidates = [
    kiwimuAssets,
    join(projectRoot, "..", "assets", "logos", "logo_2_minimalist_icon_transparent.png"),
    join(projectRoot, "assets", "logos", "logo_2_minimalist_icon_transparent.png"),
    "/app/assets/logos/logo_2_minimalist_icon_transparent.png", // Docker path
    join(staticDir, "logo.png"), // already copied via assetsDir → use it as the source
  ];
  const logoFile = logoCandidates.find(p => existsSync(p)) || null;
  if (logoFile && logoFile !== join(staticDir, "logo.png")) {
    cpSync(logoFile, join(staticDir, "logo.png"));
  }

  // Browsers fetch /favicon.ico from the site root regardless of HTML markup,
  // so we mirror it from the bundled static assets if present.
  const faviconSrc = join(staticDir, "favicon.ico");
  if (existsSync(faviconSrc)) {
    cpSync(faviconSrc, join(outputDir, "favicon.ico"));
  } else if (logoFile) {
    // Fall back to the logo as a favicon so /favicon.ico never 404s.
    cpSync(logoFile, join(outputDir, "favicon.ico"));
  }

  const pages = store.listPages();
  const sourcePages = store.listSourcePages();
  const conceptPages = store.listConceptPages();
  const wikiName = config.project.name;
  const backlinksMap = store.getAllBacklinksGrouped();
  const allSlugs = new Set(pages.map(p => p.slug));
  const categories = config.categories;

  // Build source_id → uri map so PageLink rows can carry sourceUri (used by templates for category grouping)
  const sourceUriMap = new Map<number, string>();
  for (const s of store.listSources()) sourceUriMap.set(s.id, s.uri);
  const sourceLink = (p: { slug: string; title: string; source_id: number; origin?: string }) => ({
    slug: p.slug,
    title: p.title,
    sourceUri: sourceUriMap.get(p.source_id),
    ...(p.origin ? { origin: p.origin } : {}),
  });

  for (const page of pages) {
    const htmlContent = await renderPageContent(page, allSlugs);

    const { body, externalRefs } = extractExternalRefs(htmlContent);
    const toc = generateToc(page.content);
    const backlinks = (backlinksMap.get(page.id) || []).map((bl) => ({
      slug: bl.slug,
      title: bl.title,
      pageType: bl.page_type,
    }));

    // Citations footer
    const citations = store.getCitationsForPage(page.id);
    const citationsHtml = renderCitationFootnotes(citations);

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
      citationsHtml,
      sourcePages: sourcePages.map(sourceLink),
      conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title, origin: p.origin })),
      categories,
    });

    await Bun.write(join(wikiDir, `${page.slug}.html`), html);
  }

  const indexHtml = renderIndex({
    wikiName,
    sourcePages: sourcePages.map(sourceLink),
    conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title })),
    sourceCount: store.countSources(),
    categories,
  });
  await Bun.write(join(outputDir, "index.html"), indexHtml);

  const graphData = buildGraphData(store);
  await Bun.write(join(outputDir, "graph-data.json"), JSON.stringify(graphData));
  await Bun.write(
    join(outputDir, "graph.html"),
    renderGraph({
      wikiName,
      sourcePages: sourcePages.map(sourceLink),
      conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title })),
      categories,
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
      sourcePages: sourcePages.map(sourceLink),
      conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title })),
      categories,
    })
  );

  // Dashboard page
  const stats = store.getLearningStats();
  const weakConcepts = store.getWeakConcepts(10);
  const recentAttempts = store.getQuizHistory(20);
  await Bun.write(
    join(outputDir, "dashboard.html"),
    renderDashboardPage({
      wikiName,
      stats,
      weakConcepts,
      recentAttempts,
      sourcePages: sourcePages.map(sourceLink),
      conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title })),
      categories,
    })
  );

  // Catalog (index) page
  const { generateContentIndex } = await import("../services/index-generator");
  const contentIndex = await generateContentIndex(store);
  await Bun.write(
    join(outputDir, "catalog.html"),
    renderCatalogPage({
      wikiName,
      categories: contentIndex.categories,
      totalPages: contentIndex.totalPages,
      totalLinks: contentIndex.totalLinks,
      generatedAt: contentIndex.generatedAt,
      sourcePages: sourcePages.map(sourceLink),
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

  const sourceUriMap = new Map<number, string>();
  for (const s of store.listSources()) sourceUriMap.set(s.id, s.uri);
  const sourceLink = (p: { slug: string; title: string; source_id: number; origin?: string }) => ({
    slug: p.slug,
    title: p.title,
    sourceUri: sourceUriMap.get(p.source_id),
    ...(p.origin ? { origin: p.origin } : {}),
  });

  // Render the single page
  const htmlContent = await renderPageContent(page);

  const { body, externalRefs } = extractExternalRefs(htmlContent);
  const toc = generateToc(page.content);
  const backlinks = (backlinksMap.get(page.id) || []).map((bl) => ({
    slug: bl.slug,
    title: bl.title,
    pageType: bl.page_type,
  }));

  // Citations footer
  const citations = store.getCitationsForPage(page.id);
  const citationsHtml = renderCitationFootnotes(citations);

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
    citationsHtml,
    sourcePages: sourcePages.map(sourceLink),
    conceptPages: conceptPages.map((p) => ({ slug: p.slug, title: p.title, origin: p.origin })),
    categories: config.categories,
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
