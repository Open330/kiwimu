interface PageLink {
  slug: string;
  title: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function base(opts: { title: string; wikiName: string; allPages: PageLink[]; activeSlug?: string; content: string }) {
  const sidebar = opts.allPages
    .map(
      (p) =>
        `<li><a href="/wiki/${p.slug}.html"${p.slug === opts.activeSlug ? ' class="active"' : ""}>${escapeHtml(p.title)}</a></li>`
    )
    .join("\n                ");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(opts.title)}</title>
    <link rel="stylesheet" href="/static/style.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
</head>
<body>
    <nav class="topbar">
        <a href="/index.html" class="topbar-brand">\u{1F95D} ${escapeHtml(opts.wikiName)}</a>
        <div class="topbar-search">
            <input type="text" id="search-input" placeholder="문서 검색..." autocomplete="off">
            <div id="search-results" class="search-dropdown"></div>
        </div>
        <div class="topbar-links">
            <a href="/graph.html" class="btn-graph">\u{1F4CA} 지식 그래프</a>
        </div>
    </nav>
    <div class="layout">
        <aside class="sidebar">
            <div class="sidebar-header">문서 목록</div>
            <ul class="page-list">
                ${sidebar}
            </ul>
        </aside>
        <main class="content">
            ${opts.content}
        </main>
    </div>
    <script src="/static/search.js"></script>
    <script>
        document.addEventListener("DOMContentLoaded", function() {
            renderMathInElement(document.body, {
                delimiters: [
                    {left: "$$", right: "$$", display: true},
                    {left: "$", right: "$", display: false},
                    {left: "\\\\(", right: "\\\\)", display: false},
                    {left: "\\\\[", right: "\\\\]", display: true}
                ]
            });
        });
    </script>
</body>
</html>`;
}

export function renderPage(opts: {
  wikiName: string;
  pageTitle: string;
  pageSlug: string;
  content: string;
  toc: string;
  backlinks: PageLink[];
  allPages: PageLink[];
}): string {
  const backlinksHtml = opts.backlinks.length
    ? `<aside class="backlinks">
        <h3>이 문서를 참조하는 문서</h3>
        <ul>${opts.backlinks.map((bl) => `<li><a href="/wiki/${bl.slug}.html">${escapeHtml(bl.title)}</a></li>`).join("")}</ul>
      </aside>`
    : "";

  const tocHtml = opts.toc
    ? `<details class="toc-box" open><summary>목차</summary>${opts.toc}</details>`
    : "";

  const content = `
<article class="wiki-page">
    <header class="page-header"><h1>${escapeHtml(opts.pageTitle)}</h1></header>
    ${tocHtml}
    <div class="page-body">${opts.content}</div>
    ${backlinksHtml}
</article>`;

  return base({
    title: `${opts.pageTitle} - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    allPages: opts.allPages,
    activeSlug: opts.pageSlug,
    content,
  });
}

export function renderIndex(opts: {
  wikiName: string;
  allPages: PageLink[];
  pageCount: number;
  sourceCount: number;
}): string {
  const cards = opts.allPages
    .map((p) => `<a href="/wiki/${p.slug}.html" class="page-card"><span class="card-title">${escapeHtml(p.title)}</span></a>`)
    .join("\n                ");

  const content = `
<div class="index-page">
    <div class="hero">
        <h1>\u{1F95D} ${escapeHtml(opts.wikiName)}</h1>
        <p class="hero-sub">나만의 학습 위키 \u00B7 ${opts.pageCount}개 문서 \u00B7 ${opts.sourceCount}개 소스</p>
    </div>
    <div class="index-grid">
        <section class="index-section">
            <h2>전체 문서</h2>
            <div class="page-cards">${cards}</div>
        </section>
        <section class="index-section">
            <h2>빠른 탐색</h2>
            <div class="quick-links">
                <a href="/graph.html" class="quick-link">\u{1F4CA} 지식 그래프 보기</a>
            </div>
        </section>
    </div>
</div>`;

  return base({ title: `${opts.wikiName} - 대문`, wikiName: opts.wikiName, allPages: opts.allPages, content });
}

export function renderGraph(opts: { wikiName: string; allPages: PageLink[] }): string {
  const content = `
<div class="graph-page">
    <h1>\u{1F4CA} 지식 그래프</h1>
    <p class="graph-desc">노드를 클릭하면 해당 문서로 이동합니다. 드래그로 노드를 이동할 수 있습니다.</p>
    <div id="graph-container"></div>
</div>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script src="/static/graph.js"></script>`;

  return base({ title: `지식 그래프 - ${opts.wikiName}`, wikiName: opts.wikiName, allPages: opts.allPages, content });
}
