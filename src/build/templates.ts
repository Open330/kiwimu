import { escapeHtml } from "../utils";

interface PageLink {
  slug: string;
  title: string;
  pageType?: string;
  origin?: string;
  sourceUri?: string;
}

/** Configurable category definition (matches SourceCategory in config.ts). */
interface CategorySpec {
  name: string;
  order: number;
  patterns: string[];
}

/**
 * Convert a glob-like pattern (`*` wildcard) into a case-insensitive RegExp.
 * Anchors are NOT applied — the result is meant to be tested against either
 * the basename or the full URI, matching either substring is acceptable.
 */
function patternToRegex(pat: string): RegExp {
  // Escape regex specials except *
  const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped, "i");
}

/**
 * Categorize a source URI against user-supplied categories. Returns the first
 * matching category; falls back to "기타" / "Other" with a high order if no match.
 * If `categories` is empty/undefined the caller should treat the result as
 * "no grouping" (caller decides — see `groupByCategory`).
 */
function categorize(
  uri: string | undefined,
  categories: CategorySpec[] | undefined
): { name: string; order: number; sortKey: string } {
  const u = uri || "";
  const base = u.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "") || "";
  if (categories && categories.length > 0) {
    for (const cat of categories) {
      for (const pat of cat.patterns) {
        const re = patternToRegex(pat);
        if (re.test(base) || re.test(u)) {
          return { name: cat.name, order: cat.order, sortKey: base };
        }
      }
    }
  }
  return { name: "기타", order: 9999, sortKey: base };
}

function groupByCategory(
  pages: PageLink[],
  categories: CategorySpec[] | undefined
): { name: string; order: number; pages: PageLink[] }[] {
  const groups = new Map<string, { name: string; order: number; pages: PageLink[] }>();
  for (const p of pages) {
    const c = categorize(p.sourceUri, categories);
    if (!groups.has(c.name)) groups.set(c.name, { name: c.name, order: c.order, pages: [] });
    groups.get(c.name)!.pages.push(p);
  }
  const sorted = [...groups.values()].sort((a, b) => a.order - b.order);
  for (const g of sorted) {
    g.pages.sort((a, b) => {
      const ka = (a.sourceUri || "") + "|" + a.title;
      const kb = (b.sourceUri || "") + "|" + b.title;
      return ka.localeCompare(kb);
    });
  }
  return sorted;
}

function sidebarHtml(sourcePages: PageLink[], conceptPages: PageLink[], activeSlug?: string, categories?: CategorySpec[]): string {
  // Group sources by category only when we have both sourceUri info AND user-defined categories.
  const hasUri = sourcePages.some((p) => p.sourceUri);
  const hasCats = !!(categories && categories.length > 0);
  let sourceItems: string;
  if (hasUri && hasCats) {
    const groups = groupByCategory(sourcePages, categories);
    sourceItems = groups
      .map((g) => {
        const items = g.pages
          .map((p) => `<li><a href="/wiki/${p.slug}.html"${p.slug === activeSlug ? ' class="active"' : ""}>${escapeHtml(p.title)}</a></li>`)
          .join("\n");
        return `<details open class="sidebar-group"><summary>${escapeHtml(g.name)} <span class="sidebar-count">${g.pages.length}</span></summary><ul class="page-list">${items}</ul></details>`;
      })
      .join("\n");
  } else {
    sourceItems = sourcePages
      .map(
        (p) =>
          `<li><a href="/wiki/${p.slug}.html"${p.slug === activeSlug ? ' class="active"' : ""}>${escapeHtml(p.title)}</a></li>`
      )
      .join("\n");
  }

  const conceptItems = conceptPages
    .map(
      (p) => {
        const icon = p.origin === 'user' ? '💬' : '📝';
        return `<li><a href="/wiki/${p.slug}.html"${p.slug === activeSlug ? ' class="active"' : ""}>${icon} ${escapeHtml(p.title)}</a></li>`;
      }
    )
    .join("\n");

  // Determine which tab is active
  const activeIsSource = sourcePages.some((p) => p.slug === activeSlug);

  return `
            <div class="sidebar-tabs">
                <button class="sidebar-tab${activeIsSource || !activeSlug ? " active" : ""}" data-tab="source">📖 원본 (${sourcePages.length})</button>
                <button class="sidebar-tab${!activeIsSource && activeSlug ? " active" : ""}" data-tab="concept">📝 개념 (${conceptPages.length})</button>
            </div>
            <div class="sidebar-panel${activeIsSource || !activeSlug ? " active" : ""}" id="tab-source">
                <ul class="page-list">${sourceItems}</ul>
            </div>
            <div class="sidebar-panel${!activeIsSource && activeSlug ? " active" : ""}" id="tab-concept">
                <ul class="page-list">${conceptItems}</ul>
            </div>
            <div class="sidebar-mobile-nav">
                <a href="/catalog.html">📑 목록</a>
                <a href="/wiki/random.html">🎲 임의 문서</a>
                <a href="/quiz.html">📝 퀴즈</a>
                <a href="/dashboard.html">📊 대시보드</a>
                <a href="/graph.html">🔗 그래프</a>
                <a href="/provenance">📚 출처</a>
                <a href="/manage">⚙️ 관리</a>
            </div>`;
}

function base(opts: {
  title: string;
  wikiName: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  activeSlug?: string;
  description?: string;
  content: string;
  categories?: CategorySpec[];
}) {
  const ogDescription = escapeHtml(opts.description || 'LLM으로 자동 생성된 학습 위키');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(opts.title)}</title>
    <meta property="og:title" content="${escapeHtml(opts.title)}">
    <meta property="og:description" content="${ogDescription}">
    <meta property="og:type" content="article">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${escapeHtml(opts.title)}">
    <meta name="description" content="${ogDescription}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/style.css">
    <link rel="stylesheet" href="/static/peek-panel.css">
    <link rel="stylesheet" href="/static/ask-wiki.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]})"></script>
    <script>
    // Mermaid: lazy-load on first need, expose window.kiwiRenderMermaid(root)
    // for static + dynamically injected content (peek panel, dynamic-qa).
    (function(){
      var loadPromise = null;
      function load(){
        if (!loadPromise) {
          loadPromise = import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs').then(function(m){
            m.default.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
            return m.default;
          });
        }
        return loadPromise;
      }
      window.kiwiRenderMermaid = function(root){
        var scope = root && root.querySelectorAll ? root : document;
        var nodes = scope.querySelectorAll('.mermaid:not([data-processed="true"])');
        if (!nodes.length) return Promise.resolve();
        return load().then(function(mermaid){
          return mermaid.run({ nodes: nodes }).catch(function(e){ console.warn('mermaid render failed', e); });
        });
      };
      document.addEventListener('DOMContentLoaded', function(){ window.kiwiRenderMermaid(); });
    })();
    </script>
</head>
<body>
    <nav class="topbar">
        <button class="topbar-menu-btn" aria-label="메뉴 열기" aria-expanded="false">☰</button>
        <a href="/index.html" class="topbar-brand">
            <img src="/static/logo.png" alt="Kiwi Mu" class="topbar-logo">
            ${escapeHtml(opts.wikiName)}
        </a>
        <div class="topbar-search">
            <input type="text" id="search-input" placeholder="문서 검색..." autocomplete="off">
            <div id="search-results" class="search-dropdown"></div>
        </div>
        <div class="topbar-links">
            <a href="/catalog.html" class="btn-graph">📑 목록</a>
            <a href="/wiki/random.html" class="btn-graph">🎲 임의</a>
            <a href="/quiz.html" class="btn-graph">📝 퀴즈</a>
            <a href="/dashboard.html" class="btn-graph">📊 대시보드</a>
            <a href="/graph.html" class="btn-graph">🔗 그래프</a>
            <a href="/manage" class="btn-graph">⚙️ 관리</a>
        </div>
    </nav>
    <div class="sidebar-overlay"></div>
    <div class="layout">
        <aside class="sidebar">
            ${sidebarHtml(opts.sourcePages, opts.conceptPages, opts.activeSlug, opts.categories)}
        </aside>
        <main class="content">
            ${opts.content}
        </main>
    </div>
    <script src="/static/search.js"></script>
    <script src="/static/dynamic-qa.js"></script>
    <script src="/static/edit-page.js"></script>
    <script src="/static/peek-panel.js"></script>
    <script src="/static/ask-wiki.js"></script>
    <script>
        // Mobile hamburger menu
        (function() {
            const menuBtn = document.querySelector('.topbar-menu-btn');
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.querySelector('.sidebar-overlay');
            if (menuBtn && sidebar) {
                menuBtn.addEventListener('click', () => {
                    const isOpen = sidebar.classList.toggle('open');
                    overlay?.classList.toggle('active');
                    menuBtn.setAttribute('aria-expanded', isOpen);
                    menuBtn.setAttribute('aria-label', isOpen ? '메뉴 닫기' : '메뉴 열기');
                });
                overlay?.addEventListener('click', () => {
                    sidebar.classList.remove('open');
                    overlay.classList.remove('active');
                });
            }
        })();
        // Sidebar tabs
        document.querySelectorAll('.sidebar-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
            });
        });
    </script>
<footer class="kiwimu-badge" style="text-align:center;padding:16px;margin-top:32px;border-top:1px solid var(--border);font-size:12px;color:var(--text-muted);">
  🥝 Built with <a href="https://github.com/Open330/kiwimu" target="_blank" rel="noopener" style="color:var(--namu-green);text-decoration:none;">Kiwi Mu</a> — 나만의 학습 위키 빌더
</footer>
</body>
</html>`;
}

export function renderPage(opts: {
  wikiName: string;
  pageTitle: string;
  pageSlug: string;
  pageType: string;
  pageId: number;
  origin?: string;
  content: string;
  externalRefs: string;
  toc: string;
  backlinks: PageLink[];
  citationsHtml?: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  categories?: CategorySpec[];
}): string {
  let typeBadge: string;
  if (opts.origin === 'user') {
    typeBadge = `<span class="page-type-badge dynamic">💬 질문 생성</span>`;
  } else {
    const typeLabel = opts.pageType === "source" ? "📖 원본 문서" : "📝 개념 문서";
    typeBadge = `<span class="page-type-badge ${opts.pageType}">${typeLabel}</span>`;
  }

  // Separate backlinks by type
  const sourceBacklinks = opts.backlinks.filter((bl) => bl.pageType === "source");
  const conceptBacklinks = opts.backlinks.filter((bl) => bl.pageType === "concept");

  let backlinksHtml = "";
  if (opts.backlinks.length) {
    let inner = "";
    if (sourceBacklinks.length) {
      inner += `<div class="backlink-group"><span class="backlink-label">📖 원본</span>${sourceBacklinks
        .map((bl) => `<a href="/wiki/${bl.slug}.html" class="backlink-item source">${escapeHtml(bl.title)}</a>`)
        .join("")}</div>`;
    }
    if (conceptBacklinks.length) {
      inner += `<div class="backlink-group"><span class="backlink-label">📝 개념</span>${conceptBacklinks
        .map((bl) => `<a href="/wiki/${bl.slug}.html" class="backlink-item concept">${escapeHtml(bl.title)}</a>`)
        .join("")}</div>`;
    }
    backlinksHtml = `<aside class="backlinks"><h3>🔗 이 문서를 참조하는 문서</h3>${inner}</aside>`;
  }

  const externalRefsHtml = opts.externalRefs
    ? `<aside class="external-refs"><h3>🌐 외부 참고 자료</h3>${opts.externalRefs}</aside>`
    : "";

  const tocHtml = opts.toc
    ? `<details class="toc-box" open><summary>목차</summary>${opts.toc}</details>`
    : "";

  const citationsHtml = opts.citationsHtml || "";

  const content = `
<article class="wiki-page" data-page-slug="${opts.pageSlug}" data-page-id="${opts.pageId}">
    <header class="page-header">
        ${typeBadge}
        <h1>${escapeHtml(opts.pageTitle)} <button class="edit-btn" data-slug="${opts.pageSlug}" title="편집">&#9998;</button></h1>
    </header>
    ${tocHtml}
    <div class="page-body">${opts.content}</div>
    ${citationsHtml}
    ${externalRefsHtml}
    ${backlinksHtml}
</article>
<div class="edit-modal" id="edit-modal" style="display:none">
  <div class="edit-modal-inner">
    <div class="edit-modal-header">
      <span>페이지 편집</span>
      <button class="edit-modal-close">&times;</button>
    </div>
    <textarea class="edit-textarea" id="edit-textarea"></textarea>
    <div class="edit-modal-footer">
      <button class="edit-cancel">취소</button>
      <button class="edit-save">저장</button>
    </div>
  </div>
</div>`;

  return base({
    title: `${opts.pageTitle} - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    categories: opts.categories,
    activeSlug: opts.pageSlug,
    description: `${opts.pageTitle} - ${opts.wikiName} 학습 위키`,
    content,
    categories: opts.categories,
  });
}

export function renderIndex(opts: {
  wikiName: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  sourceCount: number;
  categories?: CategorySpec[];
}): string {
  // Group source cards only when both sourceUri AND user categories are present.
  const sourceHasUri = opts.sourcePages.some((p) => p.sourceUri);
  const hasCats = !!(opts.categories && opts.categories.length > 0);
  const shouldGroup = sourceHasUri && hasCats;
  const sourceCards = shouldGroup
    ? groupByCategory(opts.sourcePages, opts.categories)
        .map((g) => {
          const cards = g.pages
            .map(
              (p) =>
                `<a href="/wiki/${p.slug}.html" class="page-card source"><span class="card-title">${escapeHtml(p.title)}</span></a>`
            )
            .join("\n");
          return `<div class="page-group"><h3 class="page-group-title">${escapeHtml(g.name)} <span class="page-group-count">${g.pages.length}</span></h3><div class="page-cards">${cards}</div></div>`;
        })
        .join("\n")
    : opts.sourcePages
        .map(
          (p) =>
            `<a href="/wiki/${p.slug}.html" class="page-card source"><span class="card-title">${escapeHtml(p.title)}</span></a>`
        )
        .join("\n");

  const conceptCards = opts.conceptPages
    .map(
      (p) =>
        `<a href="/wiki/${p.slug}.html" class="page-card concept"><span class="card-title">${escapeHtml(p.title)}</span></a>`
    )
    .join("\n");

  const totalPages = opts.sourcePages.length + opts.conceptPages.length;

  const content = `
<div class="index-page">
    <div class="hero">
        <img src="/static/logo.png" alt="Kiwi Mu" class="hero-logo">
        <h1>${escapeHtml(opts.wikiName)}</h1>
        <p class="hero-sub">나만의 학습 위키 · ${totalPages}개 문서 (📖 ${opts.sourcePages.length} + 📝 ${opts.conceptPages.length}) · ${opts.sourceCount}개 소스</p>
    </div>

    <div class="index-grid">
        <!-- Add document link -->
        <section class="index-section add-section">
            <h2>➕ 문서 추가</h2>
            <p>문서를 추가하려면 <a href="/manage">관리 페이지</a>에서 문서를 추가하세요.</p>
        </section>

        <section class="index-section">
            <h2>📖 원본 문서</h2>
            ${sourceCards.length > 0 ? (shouldGroup ? sourceCards : `<div class="page-cards">${sourceCards}</div>`) : '<div class="page-cards"><div class="empty-state">아직 원본 문서가 없습니다. URL이나 파일을 추가해보세요!</div></div>'}
        </section>
        <section class="index-section">
            <h2>📝 개념 문서</h2>
            <div class="page-cards">${conceptCards.length > 0 ? conceptCards : '<div class="empty-state">아직 개념 문서가 없습니다. 원본 문서를 추가하면 자동으로 생성됩니다.</div>'}</div>
        </section>
        <section class="index-section">
            <div class="quick-links">
                <a href="/catalog.html" class="quick-link">📑 문서 목록</a>
                <a href="/quiz.html" class="quick-link">📝 학습 퀴즈</a>
                <a href="/graph.html" class="quick-link">📊 지식 그래프 보기</a>
            </div>
        </section>
    </div>
</div>`;


  return base({
    title: `${opts.wikiName} - 대문`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    categories: opts.categories,
    description: `${opts.wikiName} — LLM으로 자동 생성된 학습 위키`,
    content,
    categories: opts.categories,
  });
}

export function renderGraph(opts: {
  wikiName: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  categories?: CategorySpec[];
}): string {
  const content = `
<div class="graph-page">
    <h1>📊 지식 그래프</h1>
    <p class="graph-desc">
        <span class="legend-dot source"></span> 원본 문서 &nbsp;
        <span class="legend-dot concept"></span> 개념 문서 &nbsp;
        · 노드를 클릭하면 해당 문서로 이동합니다
    </p>
    <div id="graph-container"></div>
</div>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script src="/static/graph.js"></script>`;

  return base({
    title: `지식 그래프 - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    content,
    categories: opts.categories,
  });
}

export function renderQuizPage(opts: {
  wikiName: string;
  quizzes: Array<{ id: number; question: string; answer: string; explanation?: string; quiz_type: string; page_title?: string; page_slug?: string }>;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  categories?: CategorySpec[];
}): string {
  const quizzesJson = JSON.stringify(opts.quizzes).replace(/</g, "\\u003c");

  const content = `
<div class="quiz-page">
    <h1>📝 학습 퀴즈</h1>
    <p class="quiz-desc">위키 내용을 기반으로 생성된 퀴즈입니다. 학습한 내용을 확인해보세요!</p>

    <div id="quiz-container">
        <div id="quiz-empty" style="display:none;">
            <p style="text-align:center;color:var(--text-muted);padding:40px 0;">퀴즈가 없습니다. 먼저 문서를 추가하세요.</p>
        </div>
        <div id="quiz-active" style="display:none;">
            <div class="quiz-progress">
                <span id="quiz-progress-text">1 / 5</span>
                <div class="quiz-progress-bar"><div id="quiz-progress-fill" class="quiz-progress-fill"></div></div>
            </div>
            <div class="quiz-card" id="quiz-card">
                <div class="quiz-card-inner" id="quiz-card-inner">
                    <div class="quiz-card-front">
                        <span class="quiz-type-badge" id="quiz-type-badge">빈칸 채우기</span>
                        <p class="quiz-question" id="quiz-question"></p>
                        <div class="quiz-input-area" id="quiz-input-area">
                            <input type="text" id="quiz-answer-input" placeholder="정답을 입력하세요..." autocomplete="off">
                            <button id="quiz-submit-btn" class="quiz-btn primary">확인</button>
                        </div>
                        <div class="quiz-ox-area" id="quiz-ox-area" style="display:none;">
                            <button class="quiz-btn ox-btn" data-answer="O">⭕ O</button>
                            <button class="quiz-btn ox-btn" data-answer="X">❌ X</button>
                        </div>
                    </div>
                    <div class="quiz-card-back">
                        <div id="quiz-result-icon" class="quiz-result-icon"></div>
                        <p class="quiz-answer-label">정답</p>
                        <p class="quiz-answer-text" id="quiz-answer-text"></p>
                        <div id="quiz-explanation" class="quiz-explanation" style="display:none;">
                            <p id="quiz-explanation-text" class="explanation-text"></p>
                        </div>
                        <p class="quiz-source" id="quiz-source"></p>
                        <p class="quiz-review-info" id="quiz-review-info" style="display:none;"></p>
                        <button id="quiz-next-btn" class="quiz-btn primary">다음 문제 →</button>
                    </div>
                </div>
            </div>
        </div>
        <div id="quiz-done" style="display:none;">
            <div class="quiz-score-card">
                <h2>🎉 퀴즈 완료!</h2>
                <div class="quiz-score">
                    <span id="quiz-score-text">0 / 5</span>
                </div>
                <div class="quiz-score-bar-container">
                    <div id="quiz-score-bar" class="quiz-score-bar"></div>
                </div>
                <p id="quiz-score-msg" class="quiz-score-msg"></p>
                <div id="quiz-stats" class="quiz-stats" style="display:none;">
                    <h3>📊 학습 통계</h3>
                    <p id="quiz-stats-summary"></p>
                    <p id="quiz-stats-weak" style="display:none;"></p>
                </div>
                <button id="quiz-restart-btn" class="quiz-btn primary">🔄 다시 풀기</button>
            </div>
        </div>
    </div>
</div>
<style>
    .quiz-page { max-width: 700px; margin: 0 auto; padding: 24px 16px; }
    .quiz-page h1 { font-size: 24px; margin-bottom: 8px; }
    .quiz-desc { color: var(--text-muted); font-size: 14px; margin-bottom: 24px; }
    .quiz-progress { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
    #quiz-progress-text { font-size: 14px; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
    .quiz-progress-bar { flex: 1; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
    .quiz-progress-fill { height: 100%; background: var(--accent, #4caf50); border-radius: 3px; transition: width 0.3s ease; }
    .quiz-card { perspective: 1000px; min-height: 300px; }
    .quiz-card-inner { position: relative; transition: transform 0.5s ease; transform-style: preserve-3d; }
    .quiz-card-inner.flipped { transform: rotateY(180deg); }
    .quiz-card-front, .quiz-card-back {
        background: var(--bg-alt, #fff); border: 1px solid var(--border); border-radius: 12px;
        padding: 32px 24px; backface-visibility: hidden;
    }
    .quiz-card-back { position: absolute; top: 0; left: 0; right: 0; transform: rotateY(180deg); text-align: center; }
    .quiz-type-badge {
        display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;
        background: var(--accent-light, #e8f5e9); color: #2e7d32; margin-bottom: 16px;
    }
    .quiz-question { font-size: 18px; line-height: 1.6; margin-bottom: 24px; font-weight: 500; }
    .quiz-input-area { display: flex; gap: 8px; }
    #quiz-answer-input {
        flex: 1; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px;
        font-size: 16px; outline: none; transition: border-color 0.2s;
    }
    #quiz-answer-input:focus { border-color: var(--accent, #4caf50); }
    .quiz-btn {
        padding: 10px 20px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600;
        cursor: pointer; transition: all 0.2s;
    }
    .quiz-btn.primary { background: var(--accent, #4caf50); color: white; }
    .quiz-btn.primary:hover { opacity: 0.9; transform: translateY(-1px); }
    .quiz-ox-area { display: flex; gap: 16px; justify-content: center; }
    .ox-btn { padding: 16px 32px; font-size: 20px; border: 2px solid var(--border); border-radius: 12px; background: var(--bg-alt, #fff); }
    .ox-btn:hover { border-color: var(--accent, #4caf50); background: var(--accent-light, #e8f5e9); }
    .quiz-result-icon { font-size: 48px; margin-bottom: 12px; }
    .quiz-answer-label { font-size: 13px; color: var(--text-muted); margin-bottom: 4px; }
    .quiz-answer-text { font-size: 22px; font-weight: 700; color: var(--accent, #4caf50); margin-bottom: 16px; }
    .quiz-source { font-size: 13px; color: var(--text-muted); margin-bottom: 20px; }
    .quiz-source a { color: var(--accent, #4caf50); text-decoration: none; }
    .quiz-source a:hover { text-decoration: underline; }
    .quiz-score-card { text-align: center; background: var(--bg-alt, #fff); border: 1px solid var(--border); border-radius: 12px; padding: 40px 24px; }
    .quiz-score { font-size: 48px; font-weight: 800; color: var(--accent, #4caf50); margin: 16px 0; }
    .quiz-score-bar-container { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; margin: 16px 0 20px; }
    .quiz-score-bar { height: 100%; background: var(--accent, #4caf50); border-radius: 4px; transition: width 0.5s ease; }
    .quiz-score-msg { font-size: 16px; color: var(--text-muted); margin-bottom: 24px; }
    .quiz-explanation { background: var(--accent-light, #e8f5e9); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; text-align: left; }
    .explanation-text { font-size: 14px; line-height: 1.6; color: var(--text, #333); margin: 0; }
    .quiz-stats { background: var(--bg-alt, #f5f5f5); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 20px; text-align: left; }
    .quiz-stats h3 { font-size: 15px; margin: 0 0 8px; }
    .quiz-stats p { font-size: 14px; color: var(--text-muted); margin: 4px 0; }
    .quiz-review-info { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; padding: 6px 12px; background: var(--accent-light, #e8f5e9); border-radius: 6px; display: inline-block; }
</style>
<script>
(function() {
    const ALL_QUIZZES = ${quizzesJson};
    const QUIZ_COUNT = Math.min(ALL_QUIZZES.length, 10);

    function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

    function normalize(s) {
        return s.trim().toLowerCase().replace(/\\s+/g, ' ');
    }

    if (ALL_QUIZZES.length === 0) {
        document.getElementById('quiz-empty').style.display = 'block';
        return;
    }

    let quizzes = [];
    let current = 0;
    let score = 0;

    function shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function startQuiz() {
        quizzes = shuffle(ALL_QUIZZES).slice(0, QUIZ_COUNT);
        current = 0;
        score = 0;
        document.getElementById('quiz-active').style.display = 'block';
        document.getElementById('quiz-done').style.display = 'none';
        showQuestion();
    }

    function typeLabel(t) {
        return t === 'fill_blank' ? '빈칸 채우기' : t === 'ox' ? 'OX 퀴즈' : '단답형';
    }

    function showQuestion() {
        const q = quizzes[current];
        const inner = document.getElementById('quiz-card-inner');
        inner.classList.remove('flipped');

        document.getElementById('quiz-progress-text').textContent = (current + 1) + ' / ' + quizzes.length;
        document.getElementById('quiz-progress-fill').style.width = ((current + 1) / quizzes.length * 100) + '%';
        document.getElementById('quiz-type-badge').textContent = typeLabel(q.quiz_type);
        document.getElementById('quiz-question').innerHTML = esc(q.question);

        const inputArea = document.getElementById('quiz-input-area');
        const oxArea = document.getElementById('quiz-ox-area');
        const answerInput = document.getElementById('quiz-answer-input');

        if (q.quiz_type === 'ox') {
            inputArea.style.display = 'none';
            oxArea.style.display = 'flex';
        } else {
            inputArea.style.display = 'flex';
            oxArea.style.display = 'none';
            answerInput.value = '';
            setTimeout(() => answerInput.focus(), 100);
        }
    }

    function checkAnswer(userAnswer) {
        const q = quizzes[current];
        const isCorrect = normalize(userAnswer) === normalize(q.answer);

        if (isCorrect) score++;

        // SM-2 spaced repetition in localStorage
        var quality = isCorrect ? 4 : 1;
        var srsData = JSON.parse(localStorage.getItem('kiwimu-srs') || '{}');
        var srs = srsData[q.id] || { ef: 2.5, interval: 0 };
        if (quality >= 3) {
            if (srs.interval === 0) srs.interval = 1;
            else if (srs.interval === 1) srs.interval = 6;
            else srs.interval = Math.round(srs.interval * srs.ef);
            srs.ef = srs.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
        } else {
            srs.interval = 0;
        }
        if (srs.ef < 1.3) srs.ef = 1.3;
        var nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + srs.interval);
        srs.nextReview = nextDate.toISOString();
        srsData[q.id] = srs;
        localStorage.setItem('kiwimu-srs', JSON.stringify(srsData));

        // Record attempt in localStorage
        var attempts = JSON.parse(localStorage.getItem('kiwimu-quiz-attempts') || '[]');
        attempts.push({ quizId: q.id, isCorrect: isCorrect, quality: quality, timestamp: new Date().toISOString() });
        localStorage.setItem('kiwimu-quiz-attempts', JSON.stringify(attempts));

        document.getElementById('quiz-result-icon').textContent = isCorrect ? '🎉' : '😅';
        document.getElementById('quiz-answer-text').innerHTML = esc(q.answer);
        document.getElementById('quiz-answer-text').style.color = isCorrect ? 'var(--accent, #4caf50)' : '#e53935';

        // Show next review info
        var reviewInfoEl = document.getElementById('quiz-review-info');
        if (srs.interval === 0) {
            reviewInfoEl.textContent = '🔄 다음 복습: 오늘';
        } else {
            reviewInfoEl.textContent = '📅 다음 복습: ' + srs.interval + '일 후';
        }
        reviewInfoEl.style.display = 'block';

        // Show explanation if available
        var explanationEl = document.getElementById('quiz-explanation');
        if (q.explanation) {
            document.getElementById('quiz-explanation-text').textContent = '💡 ' + q.explanation;
            explanationEl.style.display = 'block';
        } else {
            explanationEl.style.display = 'none';
        }

        const sourceEl = document.getElementById('quiz-source');
        if (q.page_slug) {
            const a = document.createElement('a');
            a.href = '/wiki/' + encodeURIComponent(q.page_slug) + '.html';
            a.textContent = '📖 ' + (q.page_title || q.page_slug) + ' 보기';
            sourceEl.textContent = '출처: ';
            sourceEl.appendChild(a);
        } else {
            sourceEl.textContent = '';
        }

        document.getElementById('quiz-card-inner').classList.add('flipped');

        const nextBtn = document.getElementById('quiz-next-btn');
        nextBtn.textContent = current < quizzes.length - 1 ? '다음 문제 →' : '결과 보기 →';
    }

    function nextQuestion() {
        current++;
        if (current >= quizzes.length) {
            showResults();
        } else {
            showQuestion();
        }
    }

    function showResults() {
        document.getElementById('quiz-active').style.display = 'none';
        document.getElementById('quiz-done').style.display = 'block';

        const pct = Math.round(score / quizzes.length * 100);
        document.getElementById('quiz-score-text').textContent = score + ' / ' + quizzes.length;
        document.getElementById('quiz-score-bar').style.width = pct + '%';

        const msgs = pct >= 90 ? '🏆 완벽에 가깝습니다!' : pct >= 70 ? '👏 잘 하셨습니다!' : pct >= 50 ? '📚 조금 더 복습해보세요!' : '💪 다시 도전해보세요!';
        document.getElementById('quiz-score-msg').textContent = msgs;

        // Show cumulative stats from localStorage
        var allAttempts = JSON.parse(localStorage.getItem('kiwimu-quiz-attempts') || '[]');
        if (allAttempts.length > 0) {
            var totalAttempts = allAttempts.length;
            var correctAttempts = allAttempts.filter(function(a) { return a.isCorrect; }).length;
            var overallPct = Math.round(correctAttempts / totalAttempts * 100);

            var statsEl = document.getElementById('quiz-stats');
            statsEl.style.display = 'block';
            document.getElementById('quiz-stats-summary').textContent = '전체 시도: ' + totalAttempts + '회 | 정답률: ' + overallPct + '%';

            // Find weak concepts (most wrong answers by page)
            var wrongByPage = {};
            allAttempts.forEach(function(a) {
                if (!a.isCorrect) {
                    var q = ALL_QUIZZES.find(function(quiz) { return quiz.id === a.quizId; });
                    if (q && q.page_title) {
                        wrongByPage[q.page_title] = (wrongByPage[q.page_title] || 0) + 1;
                    }
                }
            });
            var weakConcepts = Object.keys(wrongByPage).sort(function(a, b) { return wrongByPage[b] - wrongByPage[a]; }).slice(0, 3);
            if (weakConcepts.length > 0) {
                var weakEl = document.getElementById('quiz-stats-weak');
                weakEl.style.display = 'block';
                weakEl.textContent = '💪 약한 개념: ' + weakConcepts.join(', ');
            }
        }
    }

    // Event listeners
    document.getElementById('quiz-submit-btn').addEventListener('click', function() {
        const val = document.getElementById('quiz-answer-input').value;
        if (val.trim()) checkAnswer(val);
    });

    document.getElementById('quiz-answer-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && this.value.trim()) checkAnswer(this.value);
    });

    document.querySelectorAll('.ox-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { checkAnswer(this.dataset.answer); });
    });

    document.getElementById('quiz-next-btn').addEventListener('click', nextQuestion);
    document.getElementById('quiz-restart-btn').addEventListener('click', startQuiz);

    startQuiz();
})();
</script>`;

  return base({
    title: `학습 퀴즈 - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    content,
  });
}

export function renderDashboardPage(opts: {
  wikiName: string;
  stats: { total: number; mastered: number; learning: number; new: number; dueToday: number };
  weakConcepts: Array<{ title: string; slug: string; wrongCount: number }>;
  recentAttempts: Array<{ quiz_id: number; question: string; is_correct: boolean; attempted_at: string }>;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  categories?: CategorySpec[];
}): string {
  const { stats } = opts;
  const progressPct = stats.total > 0 ? Math.round((stats.mastered / stats.total) * 100) : 0;

  const weakConceptsHtml = opts.weakConcepts.length > 0
    ? opts.weakConcepts.map(c =>
        `<li><a href="/wiki/${c.slug}.html">${escapeHtml(c.title)}</a> <span class="dash-weak-count">오답 ${c.wrongCount}회</span></li>`
      ).join("")
    : `<li class="dash-empty">아직 데이터가 없습니다.</li>`;

  const recentHtml = opts.recentAttempts.length > 0
    ? opts.recentAttempts.map(a => {
        const icon = a.is_correct ? '✅' : '❌';
        const date = a.attempted_at ? a.attempted_at.slice(0, 10) : '';
        return `<li>${icon} <span class="dash-q">${escapeHtml(a.question.length > 60 ? a.question.slice(0, 57) + '...' : a.question)}</span> <span class="dash-date">${date}</span></li>`;
      }).join("")
    : `<li class="dash-empty">아직 시도한 퀴즈가 없습니다.</li>`;

  const content = `
<div class="dash-page">
    <h1>📊 학습 대시보드</h1>
    <p class="dash-desc">스페이스드 리피티션(SM-2) 기반 학습 현황을 확인하세요.</p>

    <div class="dash-cards">
        <div class="dash-card">
            <div class="dash-card-value">${stats.total}</div>
            <div class="dash-card-label">전체 문제</div>
        </div>
        <div class="dash-card dash-card-mastered">
            <div class="dash-card-value">${stats.mastered}</div>
            <div class="dash-card-label">숙달</div>
        </div>
        <div class="dash-card dash-card-learning">
            <div class="dash-card-value">${stats.learning}</div>
            <div class="dash-card-label">학습중</div>
        </div>
        <div class="dash-card dash-card-new">
            <div class="dash-card-value">${stats.new}</div>
            <div class="dash-card-label">새 문제</div>
        </div>
        <div class="dash-card dash-card-due">
            <div class="dash-card-value">${stats.dueToday}</div>
            <div class="dash-card-label">오늘 복습</div>
        </div>
    </div>

    <div class="dash-progress-section">
        <h2>📈 숙달 진행률</h2>
        <div class="dash-progress-bar-container">
            <div class="dash-progress-bar" style="width:${progressPct}%"></div>
        </div>
        <p class="dash-progress-text">${stats.mastered} / ${stats.total} 문제 숙달 (${progressPct}%)</p>
    </div>

    <div class="dash-columns">
        <div class="dash-section">
            <h2>💪 약한 개념</h2>
            <ul class="dash-list">${weakConceptsHtml}</ul>
        </div>
        <div class="dash-section">
            <h2>🕐 최근 시도</h2>
            <ul class="dash-list">${recentHtml}</ul>
        </div>
    </div>

    <div class="dash-action">
        <a href="/quiz.html" class="dash-review-btn">📝 복습 시작</a>
    </div>
</div>
<style>
    .dash-page { max-width: 800px; margin: 0 auto; padding: 24px 16px; }
    .dash-page h1 { font-size: 24px; margin-bottom: 8px; }
    .dash-page h2 { font-size: 18px; margin-bottom: 12px; }
    .dash-desc { color: var(--text-muted); font-size: 14px; margin-bottom: 24px; }
    .dash-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 28px; }
    .dash-card {
        background: var(--bg-alt, #fff); border: 1px solid var(--border); border-radius: 10px;
        padding: 16px; text-align: center;
    }
    .dash-card-value { font-size: 28px; font-weight: 800; color: var(--text); }
    .dash-card-label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
    .dash-card-mastered .dash-card-value { color: #2e7d32; }
    .dash-card-learning .dash-card-value { color: #f9a825; }
    .dash-card-new .dash-card-value { color: #1565c0; }
    .dash-card-due .dash-card-value { color: #e53935; }
    .dash-progress-section { margin-bottom: 28px; }
    .dash-progress-bar-container { height: 10px; background: var(--border); border-radius: 5px; overflow: hidden; margin: 8px 0; }
    .dash-progress-bar { height: 100%; background: #2e7d32; border-radius: 5px; transition: width 0.5s ease; }
    .dash-progress-text { font-size: 14px; color: var(--text-muted); }
    .dash-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 28px; }
    @media (max-width: 600px) { .dash-columns { grid-template-columns: 1fr; } }
    .dash-section { background: var(--bg-alt, #fff); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .dash-list { list-style: none; padding: 0; margin: 0; }
    .dash-list li { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .dash-list li:last-child { border-bottom: none; }
    .dash-list a { color: var(--accent, #4caf50); text-decoration: none; }
    .dash-list a:hover { text-decoration: underline; }
    .dash-weak-count { font-size: 12px; color: #e53935; margin-left: auto; white-space: nowrap; }
    .dash-date { font-size: 12px; color: var(--text-muted); margin-left: auto; white-space: nowrap; }
    .dash-q { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dash-empty { color: var(--text-muted); font-style: italic; }
    .dash-action { text-align: center; margin-top: 8px; }
    .dash-review-btn {
        display: inline-block; padding: 12px 32px; background: var(--accent, #4caf50); color: white;
        border-radius: 8px; font-size: 16px; font-weight: 600; text-decoration: none; transition: opacity 0.2s;
    }
    .dash-review-btn:hover { opacity: 0.9; }
</style>`;

  return base({
    title: `📊 학습 대시보드 — ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    content,
  });
}

export function renderAdmin(opts: {
  wikiName: string;
  sources: Array<{ id: number; uri: string; type: string; title: string; fetched_at: string }>;
  usage: { totalCalls: number; promptTokens: number; completionTokens: number; totalTokens: number; totalCost: number };
  llmConfig: { provider: string; model: string; api_key: string; endpoint: string };
  personas: Array<{ name: string; description: string; system_prompt: string; content_style: string }>;
  activePersona: string;
  authToken?: string;
}): string {
  const maskedKey = opts.llmConfig.api_key ? "••••" + opts.llmConfig.api_key.slice(-4) : "(미설정)";
  const sourceRows = opts.sources
    .map(
      (s) =>
        `<tr><td>${s.id}</td><td><span class="badge">${s.type}</span></td><td>${escapeHtml(s.title || "")}</td><td class="uri-cell" title="${escapeHtml(s.uri)}">${escapeHtml(s.uri.length > 50 ? "..." + s.uri.slice(-47) : s.uri)}</td><td>${s.fetched_at}</td></tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>관리 - ${escapeHtml(opts.wikiName)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/style.css">
    <style>
        .admin-page { max-width: 900px; margin: 80px auto; padding: 0 24px; }
        .admin-page h1 { font-size: 24px; margin-bottom: 24px; }
        .admin-section { margin-bottom: 32px; }
        .admin-section h2 { font-size: 18px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
        .admin-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .admin-table th, .admin-table td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }
        .admin-table th { background: var(--bg-alt); font-weight: 600; }
        .uri-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .badge { padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
        .badge { background: var(--accent-light); color: #2e7d32; }
        .config-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
        .config-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); }
        .config-row:last-child { border: none; }
        .config-key { font-weight: 600; color: var(--text-muted); min-width: 100px; }
        .config-value { font-family: monospace; }
        .config-input { flex: 1; padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; font-size: 14px; font-family: monospace; }
        .config-input:focus { outline: none; border-color: var(--accent); }
        select.config-input { font-family: inherit; }
        .config-hint { font-size: 12px; color: var(--text-muted); margin-left: 8px; }
        .save-btn { padding: 6px 16px; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; }
        .save-btn:hover { background: #43a047; }
        #save-status { font-size: 13px; margin-left: 8px; }
    </style>
</head>
<body>
    <nav class="topbar">
        <a href="/index.html" class="topbar-brand">
            <img src="/static/logo.png" alt="Kiwi Mu" class="topbar-logo">
            ${escapeHtml(opts.wikiName)}
        </a>
        <div class="topbar-links">
            <a href="/index.html" class="btn-graph">🏠 홈</a>
            <a href="/graph.html" class="btn-graph">📊 그래프</a>
            <a href="/manage" class="btn-graph" style="border-color: var(--accent);">⚙️ 관리</a>
        </div>
    </nav>
    <div class="admin-page">
        <h1>⚙️ 관리</h1>

        <div class="admin-section">
            <h2>📋 일반 설정</h2>
            <form id="general-form" class="config-card">
                <div class="config-row">
                    <span class="config-key">위키 이름</span>
                    <input id="wiki-name" class="config-input" value="${escapeHtml(opts.wikiName)}">
                    <button type="submit" class="save-btn">💾 저장</button>
                    <span id="general-save-status"></span>
                </div>
            </form>
        </div>

        <div class="admin-section">
            <h2>🤖 LLM 설정</h2>
            <form id="llm-form" class="config-card">
                <div class="config-row">
                    <span class="config-key">프로바이더</span>
                    <select id="llm-provider" class="config-input">
                        <option value="gemini"${opts.llmConfig.provider === "gemini" ? " selected" : ""}>Google Gemini</option>
                        <option value="azure-openai"${opts.llmConfig.provider === "azure-openai" ? " selected" : ""}>Azure OpenAI</option>
                        <option value="openai"${opts.llmConfig.provider === "openai" ? " selected" : ""}>OpenAI</option>
                        <option value="anthropic"${opts.llmConfig.provider === "anthropic" ? " selected" : ""}>Anthropic</option>
                    </select>
                </div>
                <div class="config-row">
                    <span class="config-key">모델</span>
                    <input id="llm-model" class="config-input" value="${escapeHtml(opts.llmConfig.model)}" placeholder="gemini-3.1-flash-lite-preview">
                </div>
                <div class="config-row">
                    <span class="config-key">API Key</span>
                    <input id="llm-key" class="config-input" type="password" placeholder="API 키 입력..." value="">
                    <span class="config-hint">${maskedKey}</span>
                </div>
                <div class="config-row" id="endpoint-row" style="${opts.llmConfig.provider === "azure-openai" ? "" : "display:none"}">
                    <span class="config-key">Endpoint</span>
                    <input id="llm-endpoint" class="config-input" value="${escapeHtml(opts.llmConfig.endpoint)}" placeholder="https://...">
                </div>
                <div class="config-row">
                    <span></span>
                    <button type="submit" class="save-btn">💾 저장</button>
                    <span id="save-status"></span>
                </div>
            </form>
            <div class="config-card" style="margin-top:12px">
                <div class="config-row"><span class="config-key">API 호출 수</span><span class="config-value">${opts.usage.totalCalls}회</span></div>
                <div class="config-row"><span class="config-key">입력 토큰</span><span class="config-value">${opts.usage.promptTokens.toLocaleString()}</span></div>
                <div class="config-row"><span class="config-key">출력 토큰</span><span class="config-value">${opts.usage.completionTokens.toLocaleString()}</span></div>
                <div class="config-row"><span class="config-key">총 토큰</span><span class="config-value">${opts.usage.totalTokens.toLocaleString()}</span></div>
                <div class="config-row"><span class="config-key">예상 비용</span><span class="config-value" style="color:#2e7d32;font-weight:700;">$${opts.usage.totalCost.toFixed(4)}</span></div>
            </div>
        </div>

        <div class="admin-section">
            <h2>🎭 페르소나 설정</h2>
            <div class="config-card" style="margin-bottom:12px">
                <div class="config-row">
                    <span class="config-key">활성 페르소나</span>
                    <select id="active-persona" class="config-input" onchange="activatePersona(this.value)">
                        ${opts.personas.map(p => `<option value="${escapeHtml(p.name)}"${p.name === opts.activePersona ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
                        <option value=""${!opts.activePersona ? " selected" : ""}>(없음 - 기본 스타일)</option>
                    </select>
                    <span id="persona-activate-status" style="font-size:13px;margin-left:8px;"></span>
                </div>
            </div>
            <div id="persona-list">
                ${opts.personas.map(p => `
                <div class="config-card persona-card" style="margin-bottom:8px;" data-name="${escapeHtml(p.name)}">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <strong style="font-size:15px;">${escapeHtml(p.name)} ${p.name === opts.activePersona ? '<span style="color:#2e7d32;font-size:12px;">✅ 활성</span>' : ''}</strong>
                        <div style="display:flex;gap:6px;">
                            <button class="save-btn" style="font-size:12px;padding:4px 10px;" onclick="editPersona('${escapeHtml(p.name)}')">✏️ 편집</button>
                            <button class="save-btn" style="font-size:12px;padding:4px 10px;background:#e53935;" onclick="deletePersona('${escapeHtml(p.name)}')">🗑️ 삭제</button>
                        </div>
                    </div>
                    <div style="font-size:13px;color:var(--text-muted);">${escapeHtml(p.description)}</div>
                </div>`).join("")}
            </div>
            <button class="save-btn" style="margin-top:8px;" onclick="showPersonaModal()">➕ 새 페르소나 추가</button>
        </div>

        <!-- Persona Modal -->
        <div id="persona-modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center;">
            <div style="background:white;border-radius:8px;padding:24px;max-width:700px;width:90%;max-height:85vh;overflow-y:auto;">
                <h3 id="persona-modal-title" style="margin-bottom:16px;">새 페르소나 추가</h3>
                <input type="hidden" id="persona-original-name" value="">
                <div style="margin-bottom:12px;">
                    <label style="font-weight:600;font-size:13px;display:block;margin-bottom:4px;">이름</label>
                    <input id="persona-name" class="config-input" style="width:100%;" placeholder="예: 나무위키, 교과서, 유머러스">
                </div>
                <div style="margin-bottom:12px;">
                    <label style="font-weight:600;font-size:13px;display:block;margin-bottom:4px;">설명</label>
                    <input id="persona-desc" class="config-input" style="width:100%;" placeholder="이 페르소나의 간단한 설명">
                </div>
                <div style="margin-bottom:12px;">
                    <label style="font-weight:600;font-size:13px;display:block;margin-bottom:4px;">시스템 프롬프트</label>
                    <textarea id="persona-system" class="config-input" style="width:100%;height:180px;resize:vertical;font-size:13px;" placeholder="LLM에게 전달할 시스템 프롬프트. 문체, 톤, 규칙 등을 지정하세요."></textarea>
                </div>
                <div style="margin-bottom:16px;">
                    <label style="font-weight:600;font-size:13px;display:block;margin-bottom:4px;">콘텐츠 스타일 지시</label>
                    <textarea id="persona-style" class="config-input" style="width:100%;height:120px;resize:vertical;font-size:13px;" placeholder="콘텐츠 생성시 적용할 스타일 가이드"></textarea>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button class="save-btn" style="background:var(--text-muted);" onclick="closePersonaModal()">취소</button>
                    <button class="save-btn" onclick="savePersona()">💾 저장</button>
                </div>
            </div>
        </div>

        <div class="admin-section">
            <h2>📚 등록된 소스 (${opts.sources.length})</h2>
            <table class="admin-table">
                <thead><tr><th>ID</th><th>타입</th><th>제목</th><th>URI</th><th>등록일</th></tr></thead>
                <tbody>${sourceRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">소스가 없습니다</td></tr>'}</tbody>
            </table>
        </div>

        <div class="admin-section">
            <h2>🔧 작업</h2>
            <div class="config-card" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
                <button class="save-btn" id="btn-build" onclick="runAction('/api/build', '빌드')">🔨 사이트 빌드</button>
                <span id="action-status" style="font-size:13px;"></span>
            </div>
        </div>

        <div class="admin-section">
            <h2>📄 지원 파일 형식</h2>
            <div class="config-card">
                <div class="config-row"><span class="config-key">URL</span><span class="config-value">웹 페이지 크롤링</span></div>
                <div class="config-row"><span class="config-key">PDF</span><span class="config-value">pdf-parse</span></div>
                <div class="config-row"><span class="config-key">DOCX</span><span class="config-value">mammoth</span></div>
                <div class="config-row"><span class="config-key">PPTX</span><span class="config-value">ZIP/XML 파싱</span></div>
                <div class="config-row"><span class="config-key">DOC / PPT / RTF</span><span class="config-value">macOS textutil</span></div>
                <div class="config-row"><span class="config-key">KEY (Keynote)</span><span class="config-value">텍스트 추출 (제한적)</span></div>
            </div>
        </div>
    </div>
    <script>
    const AUTH_TOKEN = ${opts.authToken ? JSON.stringify(opts.authToken).replace(/</g, "\\u003c") : "''"};
    const authHeaders = AUTH_TOKEN ? { 'Authorization': 'Bearer ' + AUTH_TOKEN } : {};
    async function runAction(url, label) {
        const status = document.getElementById('action-status');
        status.textContent = '⏳ ' + label + ' 중...';
        status.style.color = '#e65100';
        try {
            const r = await fetch(url, { method: 'POST', headers: authHeaders });
            if (!r.ok) { const d = await r.json(); status.textContent = '❌ ' + (d.error || '실패'); status.style.color = '#c62828'; return; }
            const poll = setInterval(async () => {
                const sr = await fetch('/api/status', { headers: authHeaders });
                const s = await sr.json();
                status.textContent = '⏳ ' + s.processingStatus;
                if (!s.processing) {
                    clearInterval(poll);
                    status.textContent = '✅ 완료!';
                    status.style.color = '#2e7d32';
                }
            }, 1000);
        } catch { status.textContent = '❌ 연결 실패'; status.style.color = '#c62828'; }
    }

    document.getElementById('general-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('general-save-status');
        const name = document.getElementById('wiki-name').value.trim();
        if (!name) return;
        try {
            const r = await fetch('/api/settings', { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify({ wiki_name: name }) });
            if (r.ok) { status.textContent = '✅ 저장됨'; status.style.color = '#2e7d32'; setTimeout(() => location.reload(), 1000); }
            else { status.textContent = '❌ 실패'; status.style.color = '#c62828'; }
        } catch { status.textContent = '❌ 연결 실패'; status.style.color = '#c62828'; }
    });

    document.getElementById('llm-provider').addEventListener('change', (e) => {
        document.getElementById('endpoint-row').style.display = e.target.value === 'azure-openai' ? '' : 'none';
        const models = { gemini: 'gemini-3.1-flash-lite-preview', 'azure-openai': 'gpt-5.4-nano', openai: 'gpt-5.4-nano', anthropic: 'claude-sonnet-4-6' };
        document.getElementById('llm-model').placeholder = models[e.target.value] || '';
    });
    document.getElementById('llm-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('save-status');
        const body = { provider: document.getElementById('llm-provider').value, model: document.getElementById('llm-model').value };
        const key = document.getElementById('llm-key').value;
        if (key) body.api_key = key;
        const ep = document.getElementById('llm-endpoint').value;
        if (ep) body.endpoint = ep;
        try {
            const r = await fetch('/api/settings', { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify(body) });
            if (r.ok) { status.textContent = '✅ 저장됨'; status.style.color = '#2e7d32'; setTimeout(() => location.reload(), 1000); }
            else { status.textContent = '❌ 실패'; status.style.color = '#c62828'; }
        } catch { status.textContent = '❌ 연결 실패'; status.style.color = '#c62828'; }
    });

    // ── Persona management ──
    let personaData = ${JSON.stringify(opts.personas).replace(/</g, "\\u003c")};

    async function activatePersona(name) {
        const status = document.getElementById('persona-activate-status');
        try {
            const r = await fetch('/api/personas', { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify({ action: 'activate', name }) });
            if (r.ok) { status.textContent = '✅'; status.style.color = '#2e7d32'; setTimeout(() => location.reload(), 800); }
            else { status.textContent = '❌'; status.style.color = '#c62828'; }
        } catch { status.textContent = '❌'; status.style.color = '#c62828'; }
    }

    function showPersonaModal(existing) {
        document.getElementById('persona-modal').style.display = 'flex';
        if (existing) {
            const p = personaData.find(x => x.name === existing);
            if (!p) return;
            document.getElementById('persona-modal-title').textContent = '페르소나 편집';
            document.getElementById('persona-original-name').value = existing;
            document.getElementById('persona-name').value = p.name;
            document.getElementById('persona-desc').value = p.description;
            document.getElementById('persona-system').value = p.system_prompt;
            document.getElementById('persona-style').value = p.content_style;
        } else {
            document.getElementById('persona-modal-title').textContent = '새 페르소나 추가';
            document.getElementById('persona-original-name').value = '';
            document.getElementById('persona-name').value = '';
            document.getElementById('persona-desc').value = '';
            document.getElementById('persona-system').value = '';
            document.getElementById('persona-style').value = '';
        }
    }

    function editPersona(name) { showPersonaModal(name); }

    function closePersonaModal() { document.getElementById('persona-modal').style.display = 'none'; }

    async function savePersona() {
        const originalName = document.getElementById('persona-original-name').value;
        const persona = {
            name: document.getElementById('persona-name').value.trim(),
            description: document.getElementById('persona-desc').value.trim(),
            system_prompt: document.getElementById('persona-system').value,
            content_style: document.getElementById('persona-style').value,
        };
        if (!persona.name) { alert('이름을 입력해주세요'); return; }
        const body = originalName
            ? { action: 'update', original_name: originalName, persona }
            : { action: 'add', persona };
        try {
            const r = await fetch('/api/personas', { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify(body) });
            if (r.ok) { closePersonaModal(); location.reload(); }
            else { const d = await r.json(); alert(d.error || '실패'); }
        } catch { alert('연결 실패'); }
    }

    async function deletePersona(name) {
        if (!confirm(name + ' 페르소나를 삭제하시겠습니까?')) return;
        try {
            const r = await fetch('/api/personas', { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify({ action: 'delete', name }) });
            if (r.ok) location.reload();
            else { const d = await r.json(); alert(d.error || '실패'); }
        } catch { alert('연결 실패'); }
    }
    </script>
</body>
</html>`;
}

export function renderCatalogPage(opts: {
  wikiName: string;
  categories: Array<{
    name: string;
    slug: string;
    description?: string;
    pages: Array<{ id: number; title: string; slug: string; type: string; linkCount: number }>;
  }>;
  totalPages: number;
  totalLinks: number;
  generatedAt: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
}): string {
  const categoriesHtml = opts.categories.map((cat) => {
    const pagesHtml = cat.pages.map((p) => {
      const typeBadge = p.type === 'source'
        ? '<span class="catalog-badge source">📖 원본</span>'
        : '<span class="catalog-badge concept">📝 개념</span>';
      const linkBadge = p.linkCount > 0
        ? `<span class="catalog-link-count" title="연결된 문서 수">🔗 ${p.linkCount}</span>`
        : '';
      return `<li class="catalog-item" data-title="${escapeHtml(p.title.toLowerCase())}">
        <a href="/wiki/${p.slug}.html">${escapeHtml(p.title)}</a>
        ${typeBadge}
        ${linkBadge}
      </li>`;
    }).join("\n");

    return `
    <details class="catalog-category" open>
      <summary class="catalog-category-header">
        <span class="catalog-category-name">${escapeHtml(cat.name)}</span>
        <span class="catalog-category-count">${cat.pages.length}개 문서</span>
      </summary>
      ${cat.description ? `<p class="catalog-category-desc">${escapeHtml(cat.description)}</p>` : ''}
      <ul class="catalog-list">${pagesHtml}</ul>
    </details>`;
  }).join("\n");

  const content = `
<div class="catalog-page">
    <h1>📑 문서 목록</h1>
    <p class="catalog-desc">전체 ${opts.totalPages}개 문서 · ${opts.totalLinks}개 링크 · ${opts.categories.length}개 카테고리</p>

    <div class="catalog-filter">
        <input type="text" id="catalog-search" placeholder="문서 이름으로 검색..." autocomplete="off">
    </div>

    <div id="catalog-categories">
        ${categoriesHtml || '<p class="catalog-empty">아직 문서가 없습니다. 소스를 추가하면 자동으로 목록이 생성됩니다.</p>'}
    </div>
</div>
<script>
(function() {
  const input = document.getElementById('catalog-search');
  if (!input) return;
  input.addEventListener('input', function() {
    const q = this.value.toLowerCase().trim();
    document.querySelectorAll('.catalog-item').forEach(function(item) {
      const title = item.getAttribute('data-title') || '';
      item.style.display = (!q || title.includes(q)) ? '' : 'none';
    });
    // Hide empty categories
    document.querySelectorAll('.catalog-category').forEach(function(cat) {
      const visible = cat.querySelectorAll('.catalog-item[style=""], .catalog-item:not([style])');
      const allItems = cat.querySelectorAll('.catalog-item');
      let visibleCount = 0;
      allItems.forEach(function(item) { if (item.style.display !== 'none') visibleCount++; });
      cat.style.display = (q && visibleCount === 0) ? 'none' : '';
    });
  });
})();
</script>`;

  return base({
    title: `문서 목록 - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    // NOTE: renderCatalogPage's `opts.categories` has its own shape
    // (catalog UI categories with `.pages`), distinct from SourceCategory.
    // We deliberately don't forward it to `base()` to avoid the name clash;
    // catalog page's sidebar therefore uses the flat fallback rendering.
    description: `${opts.wikiName} 전체 문서 목록 — ${opts.totalPages}개 문서`,
    content,
  });
}

export function renderProvenancePage(opts: {
  wikiName: string;
  coverage: Array<{
    sourceId: number;
    sourceTitle: string;
    citationCount: number;
    pageCount: number;
    pages: Array<{ title: string; slug: string }>;
  }>;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  categories?: CategorySpec[];
}): string {
  const totalCitations = opts.coverage.reduce((s, c) => s + c.citationCount, 0);
  const totalSourcesCited = opts.coverage.filter(c => c.citationCount > 0).length;

  const rows = opts.coverage.map(c => {
    const pageLinks = c.pages.map(p =>
      `<a href="/wiki/${p.slug}.html" class="provenance-page-link">${escapeHtml(p.title)}</a>`
    ).join(", ") || '<span class="text-muted">-</span>';

    const barWidth = totalCitations > 0 ? Math.max(2, Math.round((c.citationCount / totalCitations) * 100)) : 0;
    const barColor = c.citationCount === 0 ? '#e0e0e0' : c.citationCount < 3 ? '#ffc107' : '#28a745';

    return `<tr>
      <td>${escapeHtml(c.sourceTitle || 'Untitled')}</td>
      <td class="text-center">${c.citationCount}</td>
      <td class="text-center">${c.pageCount}</td>
      <td><div class="provenance-bar" style="width:${barWidth}%;background:${barColor}"></div></td>
      <td class="provenance-pages">${pageLinks}</td>
    </tr>`;
  }).join("\n");

  const content = `
<div class="provenance-page">
  <h1>Source Provenance</h1>
  <p class="provenance-summary">
    ${totalCitations} citations across ${totalSourcesCited}/${opts.coverage.length} sources
  </p>

  <table class="provenance-table">
    <thead>
      <tr>
        <th>Source</th>
        <th class="text-center">Citations</th>
        <th class="text-center">Pages</th>
        <th>Coverage</th>
        <th>Citing Pages</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  ${opts.coverage.some(c => c.citationCount === 0) ? `
  <div class="provenance-warning">
    <strong>Uncited sources:</strong>
    ${opts.coverage.filter(c => c.citationCount === 0).map(c => escapeHtml(c.sourceTitle || 'Untitled')).join(", ")}
    <br><small>Run <code>kiwimu cite</code> to retroactively generate citations for existing content.</small>
  </div>` : ''}
</div>

<style>
.provenance-page { max-width: 960px; margin: 0 auto; }
.provenance-page h1 { margin-bottom: 8px; }
.provenance-summary { color: var(--text-muted); margin-bottom: 24px; }
.provenance-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.provenance-table th, .provenance-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; }
.provenance-table th { font-weight: 600; background: var(--bg-secondary, #f8f9fa); }
.text-center { text-align: center !important; }
.text-muted { color: var(--text-muted, #999); }
.provenance-bar { height: 8px; border-radius: 4px; min-width: 2px; }
.provenance-pages { font-size: 12px; }
.provenance-page-link { display: inline-block; margin: 2px 4px 2px 0; padding: 1px 6px; background: var(--bg-secondary, #f0f0f0); border-radius: 3px; text-decoration: none; color: var(--namu-green, #2e7d32); }
.provenance-page-link:hover { background: var(--namu-green, #2e7d32); color: white; }
.provenance-warning { margin-top: 24px; padding: 12px 16px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; font-size: 13px; }
</style>`;

  return base({
    title: `Source Provenance - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    content,
  });
}

export function renderActivityPage(
  authToken: string,
  wikiName: string,
  stats: { total: number; byAction: Record<string, number>; recentDays: { date: string; count: number }[] }
): string {
  const actionIcons: Record<string, string> = {
    ingest: "\u{1F4E5}", page_created: "\u{1F4C4}", page_updated: "\u270F\uFE0F", quiz_generated: "\u{1F9E9}",
    quiz_attempted: "\u{1F4DD}", query: "\u2753", build: "\u{1F528}", deploy: "\u{1F680}", expand: "\u{1F9E0}",
  };
  const actionLabels: Record<string, string> = {
    ingest: "Ingest", page_created: "Page Created", page_updated: "Page Updated",
    quiz_generated: "Quiz Generated", quiz_attempted: "Quiz Attempted", query: "Q&A",
    build: "Build", deploy: "Deploy", expand: "Expand",
  };
  const filterButtons = Object.entries(stats.byAction)
    .map(([action, count]) => `<button class="filter-btn" data-action="${action}">${actionIcons[action] || "\u{1F4CC}"} ${actionLabels[action] || action} <span class="count">(${count})</span></button>`)
    .join("\n          ");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="kiwi-auth" content="${authToken}">
  <title>Activity Log - ${wikiName}</title>
  <style>
    :root { --bg: #fff; --fg: #1a1a2e; --card-bg: #f8f9fa; --border: #e0e0e0; --accent: #4a90d9; --muted: #6c757d; --badge-bg: #e8f0fe; --badge-fg: #1a73e8; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #1a1a2e; --fg: #e0e0e0; --card-bg: #16213e; --border: #2a2a4a; --accent: #64b5f6; --muted: #9e9e9e; --badge-bg: #1e3a5f; --badge-fg: #90caf9; }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; }
    .container { max-width: 860px; margin: 0 auto; padding: 2rem 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: var(--muted); margin-bottom: 1.5rem; }
    .filters { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1.5rem; }
    .filter-btn { background: var(--card-bg); border: 1px solid var(--border); border-radius: 1rem; padding: 0.3rem 0.8rem; cursor: pointer; font-size: 0.85rem; color: var(--fg); transition: all 0.15s; }
    .filter-btn:hover, .filter-btn.active { background: var(--badge-bg); color: var(--badge-fg); border-color: var(--accent); }
    .filter-btn .count { color: var(--muted); font-size: 0.75rem; }
    .timeline { list-style: none; border-left: 2px solid var(--border); padding-left: 1.5rem; }
    .timeline-item { position: relative; padding: 0.75rem 0; }
    .timeline-item::before { content: ""; position: absolute; left: -1.75rem; top: 1.1rem; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
    .timeline-item .time { font-size: 0.75rem; color: var(--muted); }
    .timeline-item .badge { display: inline-block; background: var(--badge-bg); color: var(--badge-fg); font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 0.75rem; margin-left: 0.5rem; }
    .timeline-item .title { font-weight: 500; margin-top: 0.15rem; }
    .timeline-item .details { font-size: 0.8rem; color: var(--muted); margin-top: 0.15rem; }
    .load-more { display: block; width: 100%; padding: 0.6rem; margin-top: 1rem; background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; cursor: pointer; color: var(--fg); font-size: 0.9rem; text-align: center; }
    .load-more:hover { background: var(--badge-bg); }
    .empty { text-align: center; color: var(--muted); padding: 3rem; }
    a.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
    a.back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <a class="back" href="/">&larr; Back to Wiki</a>
    <h1>Activity Log</h1>
    <p class="subtitle">${stats.total} total events</p>
    <div class="filters">
      <button class="filter-btn active" data-action="">All (${stats.total})</button>
      ${filterButtons}
    </div>
    <ul class="timeline" id="timeline"></ul>
    <button class="load-more" id="load-more">Load more</button>
    <div class="empty" id="empty" style="display:none;">No activity yet.</div>
  </div>
  <script>
    const authToken = document.querySelector('meta[name="kiwi-auth"]')?.content || '';
    const icons = ${JSON.stringify(actionIcons)};
    const labels = ${JSON.stringify(actionLabels)};
    let currentAction = '';
    let offset = 0;
    const limit = 50;

    function formatTime(iso) {
      const d = new Date(iso + 'Z');
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    }

    function esc(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }

    function renderEntry(e) {
      const icon = icons[e.action] || '\u{1F4CC}';
      const label = labels[e.action] || e.action;
      let detailsHtml = '';
      if (e.details) {
        try {
          const d = JSON.parse(e.details);
          detailsHtml = '<span class="details">' + Object.entries(d).map(([k,v]) => esc(k) + ': ' + esc(String(v).slice(0,60))).join(' | ') + '</span>';
        } catch {}
      }
      return '<li class="timeline-item" data-action="' + esc(e.action) + '">' +
        '<span class="time">' + formatTime(e.created_at) + '</span>' +
        '<span class="badge">' + icon + ' ' + esc(label) + '</span>' +
        '<div class="title">' + esc(e.title || '') + '</div>' +
        detailsHtml + '</li>';
    }

    async function loadEntries(append) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset), token: authToken });
      if (currentAction) params.set('action', currentAction);
      const res = await fetch('/api/activity?' + params);
      const data = await res.json();
      const entries = data.entries;
      const tl = document.getElementById('timeline');
      if (!append) tl.innerHTML = '';
      if (entries.length === 0 && offset === 0) {
        document.getElementById('empty').style.display = '';
        document.getElementById('load-more').style.display = 'none';
      } else {
        document.getElementById('empty').style.display = 'none';
        document.getElementById('load-more').style.display = entries.length < limit ? 'none' : '';
        tl.innerHTML += entries.map(renderEntry).join('');
      }
    }

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentAction = btn.dataset.action;
        offset = 0;
        loadEntries(false);
      });
    });

    document.getElementById('load-more').addEventListener('click', () => {
      offset += limit;
      loadEntries(true);
    });

    loadEntries(false);
  </script>
</body>
</html>`;
}
