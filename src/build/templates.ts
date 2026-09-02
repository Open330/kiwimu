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

/** Site-wide SEO/social metadata threaded into every generated <head>. */
export interface SiteSeo {
  /** Absolute site base (origin + optional base path) without a trailing slash; undefined when unresolvable. */
  siteUrl?: string;
  /** `<html lang>` value; defaults to "ko". */
  lang?: string;
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

const SIDEBAR_PAGE_LIMIT_PER_TAB = 100;

interface SidebarPageIndex {
  bySlug: Map<string, PageLink>;
  hasSourceUri: boolean;
}

const sidebarPageIndexes = new WeakMap<PageLink[], SidebarPageIndex>();

function getSidebarPageIndex(pages: PageLink[]): SidebarPageIndex {
  const cached = sidebarPageIndexes.get(pages);
  if (cached) return cached;

  const bySlug = new Map<string, PageLink>();
  let hasSourceUri = false;
  for (const page of pages) {
    bySlug.set(page.slug, page);
    if (page.sourceUri) hasSourceUri = true;
  }
  const index: SidebarPageIndex = { bySlug, hasSourceUri };
  sidebarPageIndexes.set(pages, index);
  return index;
}

function boundedSidebarPages(pages: PageLink[], activePage?: PageLink): PageLink[] {
  if (pages.length <= SIDEBAR_PAGE_LIMIT_PER_TAB) return pages;

  const visible = pages.slice(0, SIDEBAR_PAGE_LIMIT_PER_TAB);
  if (!activePage || visible.includes(activePage)) return visible;

  return [
    ...visible.slice(0, SIDEBAR_PAGE_LIMIT_PER_TAB - 1),
    activePage,
  ];
}

function sidebarOverflowHtml(total: number, visible: number): string {
  const omitted = total - visible;
  if (omitted <= 0) return "";
  return `<p class="sidebar-empty">${omitted}개 문서 생략 · <a href="/catalog.html">전체 목록 보기</a></p>`;
}

function sidebarHtml(sourcePages: PageLink[], conceptPages: PageLink[], activeSlug?: string, categories?: CategorySpec[]): string {
  const sourceIndex = getSidebarPageIndex(sourcePages);
  const conceptIndex = getSidebarPageIndex(conceptPages);
  const activeSourcePage = activeSlug ? sourceIndex.bySlug.get(activeSlug) : undefined;
  const activeConceptPage = activeSlug ? conceptIndex.bySlug.get(activeSlug) : undefined;
  const visibleSourcePages = boundedSidebarPages(sourcePages, activeSourcePage);
  const visibleConceptPages = boundedSidebarPages(conceptPages, activeConceptPage);

  // Group sources by category only when we have both sourceUri info AND user-defined categories.
  const hasUri = sourceIndex.hasSourceUri;
  const hasCats = !!(categories && categories.length > 0);
  let sourceItems: string;
  if (hasUri && hasCats) {
    const groups = groupByCategory(visibleSourcePages, categories);
    sourceItems = groups
      .map((g) => {
        const items = g.pages
          .map((p) => `<li><a href="/wiki/${p.slug}.html"${p.slug === activeSlug ? ' class="active"' : ""}>${escapeHtml(p.title)}</a></li>`)
          .join("\n");
        return `<details open class="sidebar-group"><summary>${escapeHtml(g.name)} <span class="sidebar-count">${g.pages.length}</span></summary><ul class="page-list">${items}</ul></details>`;
      })
      .join("\n");
  } else {
    sourceItems = visibleSourcePages
      .map(
        (p) =>
          `<li><a href="/wiki/${p.slug}.html"${p.slug === activeSlug ? ' class="active"' : ""}>${escapeHtml(p.title)}</a></li>`
      )
      .join("\n");
  }

  const conceptItems = visibleConceptPages
    .map(
      (p) => {
        const icon = p.origin === 'user' ? '💬' : '📝';
        return `<li><a href="/wiki/${p.slug}.html"${p.slug === activeSlug ? ' class="active"' : ""}>${icon} ${escapeHtml(p.title)}</a></li>`;
      }
    )
    .join("\n");

  // Determine which tab is active
  const activeIsSource = Boolean(activeSourcePage);
  const sourceActive = activeIsSource || !activeSlug;
  const conceptActive = !sourceActive;

  return `
            <div class="sidebar-tabs" role="tablist" aria-label="문서 유형">
                <button type="button" id="sidebar-tab-source" class="sidebar-tab${sourceActive ? " active" : ""}" data-tab="source" role="tab" aria-selected="${sourceActive}" aria-controls="tab-source" tabindex="${sourceActive ? "0" : "-1"}">📖 원본 (${sourcePages.length})</button>
                <button type="button" id="sidebar-tab-concept" class="sidebar-tab${conceptActive ? " active" : ""}" data-tab="concept" role="tab" aria-selected="${conceptActive}" aria-controls="tab-concept" tabindex="${conceptActive ? "0" : "-1"}">📝 개념 (${conceptPages.length})</button>
            </div>
            <div class="sidebar-panel${sourceActive ? " active" : ""}" id="tab-source" role="tabpanel" aria-labelledby="sidebar-tab-source"${sourceActive ? "" : " hidden"}>
                ${sourceItems ? `<ul class="page-list">${sourceItems}</ul>` : '<p class="sidebar-empty">원본 문서가 없습니다.</p>'}
                ${sidebarOverflowHtml(sourcePages.length, visibleSourcePages.length)}
            </div>
            <div class="sidebar-panel${conceptActive ? " active" : ""}" id="tab-concept" role="tabpanel" aria-labelledby="sidebar-tab-concept"${conceptActive ? "" : " hidden"}>
                ${conceptItems ? `<ul class="page-list">${conceptItems}</ul>` : '<p class="sidebar-empty">개념 문서가 없습니다.</p>'}
                ${sidebarOverflowHtml(conceptPages.length, visibleConceptPages.length)}
            </div>
            <nav class="sidebar-mobile-nav" aria-label="모바일 주요 메뉴">
                <a href="/catalog.html">📑 목록</a>
                <a href="/wiki/random.html">🎲 임의 문서</a>
                <a href="/quiz.html">📝 퀴즈</a>
                <a href="/dashboard.html">📊 대시보드</a>
                <a href="/graph.html">🔗 그래프</a>
                <a href="/provenance.html">📚 출처</a>
                <a href="/manage" class="live-only">⚙️ 관리</a>
            </nav>`;
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
  seo?: SiteSeo;
  /** Root-relative path of this page, e.g. "/wiki/foo.html"; drives canonical + og:url. */
  route?: string;
  /** Root-relative og:image path; falls back to the shipped logo when omitted. */
  ogImage?: string;
}) {
  const ogDescription = escapeHtml(opts.description || 'LLM으로 자동 생성된 학습 위키');
  const lang = escapeHtml(opts.seo?.lang || 'ko');
  const siteUrl = opts.seo?.siteUrl;
  const ogImagePath = opts.ogImage || '/static/logo.png';
  const ogImageUrl = escapeHtml(siteUrl ? `${siteUrl}${ogImagePath}` : ogImagePath);
  const canonicalUrl = siteUrl && opts.route ? escapeHtml(`${siteUrl}${opts.route}`) : undefined;
  const canonicalTag = canonicalUrl ? `\n    <link rel="canonical" href="${canonicalUrl}">` : '';
  const ogUrlTag = canonicalUrl ? `\n    <meta property="og:url" content="${canonicalUrl}">` : '';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(opts.title)}</title>${canonicalTag}
    <meta property="og:title" content="${escapeHtml(opts.title)}">
    <meta property="og:description" content="${ogDescription}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="${escapeHtml(opts.wikiName)}">
    <meta property="og:image" content="${ogImageUrl}">${ogUrlTag}
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${escapeHtml(opts.title)}">
    <meta name="twitter:image" content="${ogImageUrl}">
    <meta name="description" content="${ogDescription}">
    <link rel="stylesheet" href="/static/style.css">
    <link rel="stylesheet" href="/static/peek-panel.css">
    <link rel="stylesheet" href="/static/ask-wiki.css">
    <script defer src="/static/vendor/katex/katex.min.js"></script>
    <script defer src="/static/vendor-runtime.js"></script>
</head>
<body>
    <a class="skip-link" href="#main-content">본문으로 건너뛰기</a>
    <nav class="topbar" aria-label="주요 메뉴">
        <button type="button" class="topbar-menu-btn" aria-label="문서 메뉴 열기" aria-expanded="false" aria-controls="wiki-sidebar">☰</button>
        <a href="/index.html" class="topbar-brand">
            <img src="/static/logo.png" alt="Kiwi Mu" class="topbar-logo">
            ${escapeHtml(opts.wikiName)}
        </a>
        <div class="topbar-search" role="search">
            <label class="visually-hidden" for="search-input">위키 문서 검색</label>
            <input type="search" id="search-input" placeholder="문서 검색…" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="search-results" aria-autocomplete="list" aria-label="위키 문서 검색">
            <div id="search-results" class="search-dropdown" role="listbox" aria-label="검색 결과"></div>
            <div id="search-status" class="visually-hidden" role="status" aria-live="polite"></div>
        </div>
        <div class="topbar-links">
            <a href="/catalog.html" class="btn-graph">📑 목록</a>
            <a href="/wiki/random.html" class="btn-graph">🎲 임의</a>
            <a href="/quiz.html" class="btn-graph">📝 퀴즈</a>
            <a href="/dashboard.html" class="btn-graph">📊 대시보드</a>
            <a href="/graph.html" class="btn-graph">🔗 그래프</a>
            <a href="/manage" class="btn-graph live-only">⚙️ 관리</a>
        </div>
    </nav>
    <div class="sidebar-overlay" aria-hidden="true"></div>
    <div class="layout">
        <aside class="sidebar" id="wiki-sidebar" aria-label="문서 탐색">
            ${sidebarHtml(opts.sourcePages, opts.conceptPages, opts.activeSlug, opts.categories)}
        </aside>
        <main class="content" id="main-content" tabindex="-1">
            ${opts.content}
        </main>
    </div>
    <script src="/static/search.js"></script>
    <script src="/static/dynamic-qa.js"></script>
    <script src="/static/edit-page.js"></script>
    <script src="/static/peek-panel.js"></script>
    <script src="/static/ask-wiki.js"></script>
    <script src="/static/navigation.js"></script>
<footer class="kiwimu-badge">
  🥝 Built with <a href="https://github.com/Open330/kiwimu" target="_blank" rel="noopener">Kiwi Mu</a> — 나만의 학습 위키 빌더
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
  seo?: SiteSeo;
  /** Root-relative og:image path; the page's first extracted figure when present. */
  ogImage?: string;
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
<article class="wiki-page" data-page-slug="${opts.pageSlug}" data-page-id="${opts.pageId}" aria-labelledby="page-title">
    <header class="page-header">
        ${typeBadge}
        <h1 id="page-title">${escapeHtml(opts.pageTitle)} <button type="button" class="edit-btn" data-slug="${opts.pageSlug}" title="페이지 편집" aria-label="${escapeHtml(opts.pageTitle)} 페이지 편집" hidden>&#9998;</button></h1>
    </header>
    ${tocHtml}
    <div class="page-body">${opts.content}</div>
    ${citationsHtml}
    ${externalRefsHtml}
    ${backlinksHtml}
</article>
<div class="edit-modal" id="edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-modal-title" aria-describedby="edit-status" hidden>
  <div class="edit-modal-inner" tabindex="-1">
    <div class="edit-modal-header">
      <h2 id="edit-modal-title">페이지 편집</h2>
      <button type="button" class="edit-modal-close" aria-label="편집 창 닫기">&times;</button>
    </div>
    <label class="visually-hidden" for="edit-textarea">마크다운 내용</label>
    <textarea class="edit-textarea" id="edit-textarea" spellcheck="true"></textarea>
    <p class="edit-status" id="edit-status" role="status" aria-live="polite"></p>
    <div class="edit-modal-footer">
      <button type="button" class="edit-cancel">취소</button>
      <button type="button" class="edit-save">저장</button>
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
    seo: opts.seo,
    route: `/wiki/${opts.pageSlug}.html`,
    ogImage: opts.ogImage,
    content,
  });
}

export function renderIndex(opts: {
  wikiName: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  sourceCount: number;
  categories?: CategorySpec[];
  seo?: SiteSeo;
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
        <section class="index-section add-section live-only">
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
    seo: opts.seo,
    route: "/index.html",
    content,
  });
}

export function renderGraph(opts: {
  wikiName: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  categories?: CategorySpec[];
  seo?: SiteSeo;
}): string {
  const content = `
<div class="graph-page">
    <h1>📊 지식 그래프</h1>
    <p class="graph-desc" id="graph-help">
        <span><span class="legend-dot source" aria-hidden="true"></span> 원본 문서</span>
        <span><span class="legend-dot concept" aria-hidden="true"></span> 개념 문서</span>
        <span>노드를 클릭하거나 키보드로 선택하면 문서로 이동합니다.</span>
    </p>
    <div class="graph-toolbar" aria-label="그래프 보기 조절">
        <button type="button" id="graph-zoom-in" aria-label="그래프 확대">＋</button>
        <button type="button" id="graph-zoom-out" aria-label="그래프 축소">－</button>
        <button type="button" id="graph-reset">화면 맞춤</button>
    </div>
    <div id="graph-container" role="region" aria-label="문서 연결 그래프" aria-describedby="graph-help" aria-busy="true">
        <p class="graph-state" id="graph-status" role="status" aria-live="polite">그래프를 불러오는 중…</p>
    </div>
</div>
<script src="/static/vendor/d3/d3.min.js"></script>
<script src="/static/graph.js"></script>`;

  return base({
    title: `지식 그래프 - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    content,
    categories: opts.categories,
    seo: opts.seo,
    route: "/graph.html",
  });
}

export function renderQuizPage(opts: {
  wikiName: string;
  quizzes: Array<{ id: number; question: string; answer: string; explanation?: string; quiz_type: string; page_title?: string; page_slug?: string }>;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  categories?: CategorySpec[];
  seo?: SiteSeo;
}): string {
  const quizzesJson = JSON.stringify(opts.quizzes).replace(/</g, "\\u003c");

  const content = `
<div class="quiz-page">
    <h1>📝 학습 퀴즈</h1>
    <p class="quiz-desc">위키 내용을 기반으로 생성된 퀴즈입니다. 학습한 내용을 확인해보세요!</p>

    <div id="quiz-container">
        <div id="quiz-empty" role="status" hidden>
            <p class="quiz-empty-message">퀴즈가 없습니다. 먼저 문서를 추가하세요.</p>
        </div>
        <div id="quiz-active" hidden>
            <div class="quiz-progress">
                <span id="quiz-progress-text" aria-live="polite">1 / 5</span>
                <progress class="quiz-progress-bar" id="quiz-progress-bar" aria-label="퀴즈 진행률" max="5" value="1"></progress>
            </div>
            <div class="quiz-card" id="quiz-card">
                <div class="quiz-card-inner" id="quiz-card-inner">
                    <div class="quiz-card-front" id="quiz-card-front" aria-hidden="false">
                        <span class="quiz-type-badge" id="quiz-type-badge">빈칸 채우기</span>
                        <p class="quiz-question" id="quiz-question"></p>
                        <p id="quiz-input-error" class="quiz-input-error" role="alert" hidden></p>
                        <div class="quiz-input-area" id="quiz-input-area">
                            <label class="visually-hidden" for="quiz-answer-input">정답</label>
                            <input type="text" id="quiz-answer-input" placeholder="정답을 입력하세요…" autocomplete="off" aria-describedby="quiz-question quiz-input-error">
                            <button type="button" id="quiz-submit-btn" class="quiz-btn primary">확인</button>
                        </div>
                        <div class="quiz-ox-area" id="quiz-ox-area" role="group" aria-labelledby="quiz-question" hidden>
                            <button type="button" class="quiz-btn ox-btn" data-answer="O" aria-label="O, 맞음">⭕ O</button>
                            <button type="button" class="quiz-btn ox-btn" data-answer="X" aria-label="X, 틀림">❌ X</button>
                        </div>
                    </div>
                    <div class="quiz-card-back" id="quiz-card-back" aria-hidden="true" inert>
                        <div id="quiz-result-icon" class="quiz-result-icon" aria-hidden="true"></div>
                        <p id="quiz-result-status" class="visually-hidden"></p>
                        <p class="quiz-answer-label">정답</p>
                        <p class="quiz-answer-text" id="quiz-answer-text"></p>
                        <div id="quiz-explanation" class="quiz-explanation" hidden>
                            <p id="quiz-explanation-text" class="explanation-text"></p>
                        </div>
                        <p class="quiz-source" id="quiz-source"></p>
                        <p class="quiz-review-info" id="quiz-review-info" hidden></p>
                        <button type="button" id="quiz-next-btn" class="quiz-btn primary">다음 문제 →</button>
                    </div>
                </div>
            </div>
            <p id="quiz-live-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></p>
        </div>
        <div id="quiz-done" hidden tabindex="-1" aria-labelledby="quiz-done-title">
            <div class="quiz-score-card">
                <h2 id="quiz-done-title">🎉 퀴즈 완료!</h2>
                <div class="quiz-score" role="status" aria-live="polite">
                    <span id="quiz-score-text">0 / 5</span>
                </div>
                <progress id="quiz-score-bar" class="quiz-score-bar" aria-label="퀴즈 점수" max="100" value="0"></progress>
                <p id="quiz-score-msg" class="quiz-score-msg"></p>
                <div id="quiz-stats" class="quiz-stats" hidden>
                    <h3>📊 학습 통계</h3>
                    <p id="quiz-stats-summary"></p>
                    <p id="quiz-stats-weak" hidden></p>
                </div>
                <button type="button" id="quiz-restart-btn" class="quiz-btn primary">🔄 다시 풀기</button>
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
    .quiz-empty-message { text-align: center; color: var(--text-muted); padding: 40px 0; }
    .quiz-progress-bar, .quiz-score-bar { appearance: none; border: 0; overflow: hidden; background: var(--border); }
    .quiz-progress-bar { flex: 1; height: 6px; border-radius: 3px; }
    .quiz-progress-bar::-webkit-progress-bar, .quiz-score-bar::-webkit-progress-bar { background: var(--border); }
    .quiz-progress-bar::-webkit-progress-value, .quiz-score-bar::-webkit-progress-value { background: var(--accent, #4caf50); }
    .quiz-progress-bar::-moz-progress-bar, .quiz-score-bar::-moz-progress-bar { background: var(--accent, #4caf50); }
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
        background: var(--accent-light, #e8f5e9); color: var(--accent-text, #006b62); margin-bottom: 16px;
    }
    .quiz-question { font-size: 18px; line-height: 1.6; margin-bottom: 24px; font-weight: 500; }
    .quiz-input-area { display: flex; gap: 8px; }
    .quiz-input-error { margin: -14px 0 8px; color: #b42318; font-size: 13px; }
    #quiz-answer-input {
        flex: 1; min-width: 0; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px;
        font-size: 16px; transition: border-color 0.2s;
    }
    #quiz-answer-input:focus { border-color: var(--accent, #4caf50); }
    .quiz-btn {
        padding: 10px 20px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600;
        cursor: pointer; transition: all 0.2s;
    }
    .quiz-btn.primary { background: var(--control-bg, #006b62); color: white; }
    .quiz-btn.primary:hover { opacity: 0.9; transform: translateY(-1px); }
    .quiz-ox-area { display: flex; gap: 16px; justify-content: center; }
    .ox-btn { padding: 16px 32px; font-size: 20px; border: 2px solid var(--border); border-radius: 12px; background: var(--bg-alt, #fff); }
    .ox-btn:hover { border-color: var(--accent, #4caf50); background: var(--accent-light, #e8f5e9); }
    .quiz-result-icon { font-size: 48px; margin-bottom: 12px; }
    .quiz-answer-label { font-size: 13px; color: var(--text-muted); margin-bottom: 4px; }
    .quiz-answer-text { font-size: 22px; font-weight: 700; color: var(--accent, #4caf50); margin-bottom: 16px; }
    .quiz-answer-text.is-incorrect { color: #e53935; }
    .quiz-source { font-size: 13px; color: var(--text-muted); margin-bottom: 20px; }
    .quiz-source a { color: var(--link, #005ea8); text-decoration: none; }
    .quiz-source a:hover { text-decoration: underline; }
    .quiz-score-card { text-align: center; background: var(--bg-alt, #fff); border: 1px solid var(--border); border-radius: 12px; padding: 40px 24px; }
    .quiz-score { font-size: 48px; font-weight: 800; color: var(--accent, #4caf50); margin: 16px 0; }
    .quiz-score-bar { width: 100%; height: 8px; border-radius: 4px; margin: 16px 0 20px; }
    .quiz-score-msg { font-size: 16px; color: var(--text-muted); margin-bottom: 24px; }
    .quiz-explanation { background: var(--accent-light, #e8f5e9); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; text-align: left; }
    .explanation-text { font-size: 14px; line-height: 1.6; color: var(--text, #333); margin: 0; }
    .quiz-stats { background: var(--bg-alt, #f5f5f5); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 20px; text-align: left; }
    .quiz-stats h3 { font-size: 15px; margin: 0 0 8px; }
    .quiz-stats p { font-size: 14px; color: var(--text-muted); margin: 4px 0; }
    .quiz-review-info { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; padding: 6px 12px; background: var(--accent-light, #e8f5e9); border-radius: 6px; display: inline-block; }
    @media (max-width: 400px) {
        .quiz-card-front, .quiz-card-back { padding: 24px 16px; }
        .quiz-input-area { flex-direction: column; }
        .quiz-input-area .quiz-btn { width: 100%; }
    }
</style>
<script id="kiwi-quiz-data" type="application/json">${quizzesJson}</script>
<script src="/static/quiz.js"></script>`;

  return base({
    title: `학습 퀴즈 - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    content,
    categories: opts.categories,
    seo: opts.seo,
    route: "/quiz.html",
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
  seo?: SiteSeo;
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

    <div class="dash-cards" role="list" aria-label="학습 현황 요약">
        <div class="dash-card" role="listitem">
            <div class="dash-card-value" id="dash-total">${stats.total}</div>
            <div class="dash-card-label">전체 문제</div>
        </div>
        <div class="dash-card dash-card-mastered" role="listitem">
            <div class="dash-card-value" id="dash-mastered">${stats.mastered}</div>
            <div class="dash-card-label">숙달</div>
        </div>
        <div class="dash-card dash-card-learning" role="listitem">
            <div class="dash-card-value" id="dash-learning">${stats.learning}</div>
            <div class="dash-card-label">학습중</div>
        </div>
        <div class="dash-card dash-card-new" role="listitem">
            <div class="dash-card-value" id="dash-new">${stats.new}</div>
            <div class="dash-card-label">새 문제</div>
        </div>
        <div class="dash-card dash-card-due" role="listitem">
            <div class="dash-card-value" id="dash-due">${stats.dueToday}</div>
            <div class="dash-card-label">오늘 복습</div>
        </div>
    </div>

    <div class="dash-progress-section">
        <h2>📈 숙달 진행률</h2>
        <progress class="dash-progress-bar" id="dash-progress-bar" aria-label="숙달 진행률" aria-valuetext="${stats.mastered} / ${stats.total} 문제 숙달" max="100" value="${progressPct}"></progress>
        <p class="dash-progress-text" id="dash-progress-text">${stats.mastered} / ${stats.total} 문제 숙달 (${progressPct}%)</p>
    </div>

    <div class="dash-columns">
        <div class="dash-section">
            <h2>💪 약한 개념</h2>
            <ul class="dash-list" id="dash-weak-list">${weakConceptsHtml}</ul>
        </div>
        <div class="dash-section">
            <h2>🕐 최근 시도</h2>
            <ul class="dash-list" id="dash-recent-list">${recentHtml}</ul>
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
    .dash-card-new .dash-card-value { color: var(--link, #005ea8); }
    .dash-card-due .dash-card-value { color: #e53935; }
    .dash-progress-section { margin-bottom: 28px; }
    .dash-progress-bar { appearance: none; width: 100%; height: 10px; border: 0; background: var(--border); border-radius: 5px; overflow: hidden; margin: 8px 0; }
    .dash-progress-bar::-webkit-progress-bar { background: var(--border); }
    .dash-progress-bar::-webkit-progress-value { background: #2e7d32; }
    .dash-progress-bar::-moz-progress-bar { background: #2e7d32; }
    .dash-progress-text { font-size: 14px; color: var(--text-muted); }
    .dash-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 28px; }
    @media (max-width: 600px) { .dash-columns { grid-template-columns: 1fr; } }
    .dash-section { background: var(--bg-alt, #fff); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .dash-list { list-style: none; padding: 0; margin: 0; }
    .dash-list li { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .dash-list li:last-child { border-bottom: none; }
    .dash-list a { color: var(--link, #005ea8); text-decoration: underline; text-underline-offset: 2px; }
    .dash-list a:hover { text-decoration: underline; }
    .dash-weak-count { font-size: 12px; color: #e53935; margin-left: auto; white-space: nowrap; }
    .dash-date { font-size: 12px; color: var(--text-muted); margin-left: auto; white-space: nowrap; }
    .dash-q { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dash-empty { color: var(--text-muted); font-style: italic; }
    .dash-action { text-align: center; margin-top: 8px; }
    .dash-review-btn {
        display: inline-block; padding: 12px 32px; background: var(--control-bg, #006b62); color: white;
        border-radius: 8px; font-size: 16px; font-weight: 600; text-decoration: none; transition: opacity 0.2s;
    }
    .dash-review-btn:hover { opacity: 0.9; }
</style>
<script src="/static/dashboard.js"></script>`;

  return base({
    title: `📊 학습 대시보드 — ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    content,
    categories: opts.categories,
    seo: opts.seo,
    route: "/dashboard.html",
  });
}

export function renderAdmin(opts: {
  wikiName: string;
  sources: Array<{ id: number; uri: string; type: string; title: string; fetched_at: string }>;
  usage: { totalCalls: number; promptTokens: number; completionTokens: number; totalTokens: number; totalCost: number };
  llmConfig: { provider: string; model: string; api_key: string; endpoint: string };
  personas: Array<{ name: string; description: string; system_prompt: string; content_style: string }>;
  activePersona: string;
  supportedUploadExtensions?: readonly string[];
}): string {
  const uploadFormats: Readonly<Record<string, { label: string; extractor: string }>> = {
    pdf: { label: "PDF", extractor: "pdf-parse" },
    docx: { label: "DOCX", extractor: "mammoth" },
    pptx: { label: "PPTX", extractor: "ZIP/XML 파싱" },
    doc: { label: "DOC", extractor: "textutil" },
    ppt: { label: "PPT", extractor: "strings" },
    key: { label: "KEY", extractor: "strings (제한적)" },
    rtf: { label: "RTF", extractor: "textutil" },
    md: { label: "Markdown", extractor: "직접 추출" },
  };
  const supportedUploadExtensions = (opts.supportedUploadExtensions ?? ["pdf", "docx", "pptx", "md"])
    .filter((extension) => Object.hasOwn(uploadFormats, extension));
  const uploadAccept = supportedUploadExtensions.map(extension => `.${extension}`).join(",");
  const uploadHint = supportedUploadExtensions.map(extension => uploadFormats[extension]!.label).join(", ");
  const uploadFormatRows = supportedUploadExtensions.map((extension) => {
    const format = uploadFormats[extension]!;
    return `<div class="config-row"><span class="config-key">${format.label}</span><span class="config-value">${format.extractor}</span></div>`;
  }).join("");
  const maskedKey = opts.llmConfig.api_key ? "••••" + opts.llmConfig.api_key.slice(-4) : "(미설정)";
  const sourceRows = opts.sources
    .map(
      (s) =>
        `<tr><td>${s.id}</td><td><span class="badge">${escapeHtml(s.type)}</span></td><td>${escapeHtml(s.title || "")}</td><td class="uri-cell" title="${escapeHtml(s.uri)}">${escapeHtml(s.uri.length > 50 ? "..." + s.uri.slice(-47) : s.uri)}</td><td>${escapeHtml(s.fetched_at)}</td></tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>관리 - ${escapeHtml(opts.wikiName)}</title>
    <meta name="description" content="${escapeHtml(opts.wikiName)} 설정과 소스를 관리합니다.">
    <link rel="stylesheet" href="/static/style.css">
    <style>
        .admin-page { max-width: 960px; margin: calc(var(--topbar-height) + 36px) auto 56px; padding: 0 24px; }
        .admin-page h1 { font-size: 24px; margin-bottom: 24px; }
        .admin-section { margin-bottom: 32px; }
        .admin-section h2 { font-size: 18px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
        .admin-table-wrap { width: 100%; overflow-x: auto; border: 1px solid var(--border); }
        .admin-table { width: 100%; min-width: 680px; border-collapse: collapse; font-size: 14px; }
        .admin-table th, .admin-table td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }
        .admin-table th { background: var(--bg-alt); font-weight: 600; }
        .uri-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .badge { padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
        .badge { background: var(--accent-light); color: var(--accent-text); }
        .config-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
        .config-row { display: flex; align-items: center; gap: 10px; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border); }
        .config-row:last-child { border: none; }
        .config-key { font-weight: 600; color: var(--text-muted); min-width: 100px; }
        .config-value { font-family: monospace; }
        .config-input { flex: 1; min-width: 0; min-height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 4px; font-size: 14px; font-family: monospace; background: var(--bg); color: var(--text); }
        .config-input:focus { border-color: var(--accent); }
        select.config-input { font-family: inherit; }
        .config-hint { font-size: 12px; color: var(--text-muted); margin-left: 8px; }
        .save-btn { min-height: 40px; padding: 8px 16px; background: var(--control-bg); color: white; border: 1px solid transparent; border-radius: 4px; cursor: pointer; font-weight: 600; }
        .save-btn:hover { background: #004f49; }
        .save-btn:disabled { opacity: .65; cursor: wait; }
        .danger-btn { background: #c62828; }
        .danger-btn:hover { background: #a51f1f; }
        .admin-status { min-height: 1.4em; font-size: 13px; margin-left: 8px; }
        .admin-status[data-tone="pending"] { color: #e65100; }
        .admin-status[data-tone="success"] { color: var(--accent-text); }
        .admin-status[data-tone="error"] { color: #c62828; }
        .admin-manage-link { border-color: var(--accent); }
        .config-card-spaced-top { margin-top: 12px; }
        .config-card-spaced-bottom { margin-bottom: 12px; }
        .source-add-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .source-add-form { display: flex; flex-direction: column; }
        .source-add-row { align-items: stretch; flex: 1; flex-direction: column; justify-content: flex-start; border-bottom: 0; }
        .source-add-row .config-key { min-width: 0; }
        .source-add-row .save-btn { align-self: flex-start; }
        .source-add-hint { margin: -2px 0 2px; color: var(--text-muted); font-size: 12px; }
        .source-add-form .admin-status { margin: 4px 0 0; }
        .usage-cost { color: var(--accent-text); font-weight: 700; }
        .persona-card { margin-bottom: 8px; }
        .persona-card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
        .persona-card-title { font-size: 15px; }
        .persona-active { color: var(--accent-text); font-size: 12px; }
        .persona-card-actions { display: flex; gap: 6px; }
        .persona-description { color: var(--text-muted); font-size: 13px; }
        .persona-add { margin-top: 8px; }
        .persona-modal-title { margin-bottom: 16px; }
        .persona-field { margin-bottom: 12px; }
        .persona-field-last { margin-bottom: 16px; }
        .persona-label { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 600; }
        .config-input-full { width: 100%; }
        .persona-system-input { height: 180px; resize: vertical; font-size: 13px; }
        .persona-style-input { height: 120px; resize: vertical; font-size: 13px; }
        .persona-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
        .secondary-btn { background: #595959; }
        .admin-empty-row { text-align: center; color: var(--text-muted); }
        .config-card-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
        .persona-modal { position: fixed; inset: 0; background: rgba(0,0,0,.58); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .persona-modal[hidden] { display: none; }
        .persona-modal-inner { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 24px; max-width: 700px; width: 100%; max-height: 85vh; overflow-y: auto; }
        @media (max-width: 640px) {
            .admin-page { margin-top: calc(var(--topbar-height) + 20px); padding: 0 14px; }
            .source-add-grid { grid-template-columns: 1fr; }
            .config-row { align-items: stretch; flex-direction: column; }
            .config-key { min-width: 0; }
            .config-hint, .admin-status { margin-left: 0; }
            .save-btn { width: 100%; }
        }
    </style>
</head>
<body>
    <a class="skip-link" href="#admin-main">본문으로 건너뛰기</a>
    <nav class="topbar" aria-label="주요 메뉴">
        <a href="/index.html" class="topbar-brand">
            <img src="/static/logo.png" alt="Kiwi Mu" class="topbar-logo">
            ${escapeHtml(opts.wikiName)}
        </a>
        <div class="topbar-links">
            <a href="/index.html" class="btn-graph">🏠 홈</a>
            <a href="/graph.html" class="btn-graph">📊 그래프</a>
            <a href="/manage" class="btn-graph admin-manage-link">⚙️ 관리</a>
        </div>
    </nav>
    <main class="admin-page" id="admin-main" tabindex="-1">
        <h1>⚙️ 관리</h1>

        <div class="admin-section">
            <h2>📋 일반 설정</h2>
            <form id="general-form" class="config-card">
                <div class="config-row">
                    <label class="config-key" for="wiki-name">위키 이름</label>
                    <input id="wiki-name" name="wiki_name" class="config-input" value="${escapeHtml(opts.wikiName)}" required maxlength="100">
                    <button type="submit" class="save-btn">💾 저장</button>
                    <span id="general-save-status" class="admin-status" role="status" aria-live="polite"></span>
                </div>
            </form>
        </div>

        <div class="admin-section">
            <h2>🤖 LLM 설정</h2>
            <form id="llm-form" class="config-card">
                <div class="config-row">
                    <label class="config-key" for="llm-provider">프로바이더</label>
                    <select id="llm-provider" class="config-input">
                        <option value="gemini"${opts.llmConfig.provider === "gemini" ? " selected" : ""}>Google Gemini</option>
                        <option value="azure-openai"${opts.llmConfig.provider === "azure-openai" ? " selected" : ""}>Azure OpenAI</option>
                        <option value="openai"${opts.llmConfig.provider === "openai" ? " selected" : ""}>OpenAI</option>
                        <option value="anthropic"${opts.llmConfig.provider === "anthropic" ? " selected" : ""}>Anthropic</option>
                    </select>
                </div>
                <div class="config-row">
                    <label class="config-key" for="llm-model">모델</label>
                    <input id="llm-model" class="config-input" value="${escapeHtml(opts.llmConfig.model)}" placeholder="gemini-3.8-flash" required>
                </div>
                <div class="config-row">
                    <label class="config-key" for="llm-key">API Key</label>
                    <input id="llm-key" class="config-input" type="password" placeholder="변경할 때만 입력" value="" autocomplete="new-password" aria-describedby="llm-key-hint">
                    <span class="config-hint" id="llm-key-hint">현재 ${escapeHtml(maskedKey)}</span>
                </div>
                <div class="config-row" id="endpoint-row"${opts.llmConfig.provider === "azure-openai" ? "" : " hidden"}>
                    <label class="config-key" for="llm-endpoint">Endpoint</label>
                    <input id="llm-endpoint" class="config-input" type="url" value="${escapeHtml(opts.llmConfig.endpoint)}" placeholder="https://…">
                </div>
                <div class="config-row">
                    <span></span>
                    <button type="submit" class="save-btn">💾 저장</button>
                    <span id="save-status" class="admin-status" role="status" aria-live="polite"></span>
                </div>
            </form>
            <div class="config-card config-card-spaced-top">
                <div class="config-row"><span class="config-key">API 호출 수</span><span class="config-value">${opts.usage.totalCalls}회</span></div>
                <div class="config-row"><span class="config-key">입력 토큰</span><span class="config-value">${opts.usage.promptTokens.toLocaleString()}</span></div>
                <div class="config-row"><span class="config-key">출력 토큰</span><span class="config-value">${opts.usage.completionTokens.toLocaleString()}</span></div>
                <div class="config-row"><span class="config-key">총 토큰</span><span class="config-value">${opts.usage.totalTokens.toLocaleString()}</span></div>
                <div class="config-row"><span class="config-key">예상 비용</span><span class="config-value usage-cost">$${opts.usage.totalCost.toFixed(4)}</span></div>
            </div>
        </div>

        <div class="admin-section">
            <h2>🎭 페르소나 설정</h2>
            <div class="config-card config-card-spaced-bottom">
                <div class="config-row">
                    <label class="config-key" for="active-persona">활성 페르소나</label>
                    <select id="active-persona" class="config-input">
                        ${opts.personas.map(p => `<option value="${escapeHtml(p.name)}"${p.name === opts.activePersona ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
                        <option value=""${!opts.activePersona ? " selected" : ""}>(없음 - 기본 스타일)</option>
                    </select>
                    <span id="persona-activate-status" class="admin-status" role="status" aria-live="polite"></span>
                </div>
            </div>
            <div id="persona-list">
                ${opts.personas.map(p => `
                <div class="config-card persona-card" data-name="${escapeHtml(p.name)}">
                    <div class="persona-card-header">
                        <strong class="persona-card-title">${escapeHtml(p.name)} ${p.name === opts.activePersona ? '<span class="persona-active">✅ 활성</span>' : ''}</strong>
                        <div class="persona-card-actions">
                            <button type="button" class="save-btn" data-persona-action="edit" data-name="${escapeHtml(p.name)}">✏️ 편집</button>
                            <button type="button" class="save-btn danger-btn" data-persona-action="delete" data-name="${escapeHtml(p.name)}">🗑️ 삭제</button>
                        </div>
                    </div>
                    <div class="persona-description">${escapeHtml(p.description)}</div>
                </div>`).join("")}
            </div>
            <button type="button" class="save-btn persona-add" id="persona-add-btn">➕ 새 페르소나 추가</button>
        </div>

        <!-- Persona Modal -->
        <div id="persona-modal" class="persona-modal" role="dialog" aria-modal="true" aria-labelledby="persona-modal-title" hidden>
            <div class="persona-modal-inner" tabindex="-1">
                <h3 id="persona-modal-title" class="persona-modal-title">새 페르소나 추가</h3>
                <input type="hidden" id="persona-original-name" value="">
                <div class="persona-field">
                    <label for="persona-name" class="persona-label">이름</label>
                    <input id="persona-name" class="config-input config-input-full" placeholder="예: 나무위키, 교과서, 유머러스" maxlength="80" required>
                </div>
                <div class="persona-field">
                    <label for="persona-desc" class="persona-label">설명</label>
                    <input id="persona-desc" class="config-input config-input-full" placeholder="이 페르소나의 간단한 설명">
                </div>
                <div class="persona-field">
                    <label for="persona-system" class="persona-label">시스템 프롬프트</label>
                    <textarea id="persona-system" class="config-input config-input-full persona-system-input" placeholder="LLM에게 전달할 시스템 프롬프트. 문체, 톤, 규칙 등을 지정하세요."></textarea>
                </div>
                <div class="persona-field-last">
                    <label for="persona-style" class="persona-label">콘텐츠 스타일 지시</label>
                    <textarea id="persona-style" class="config-input config-input-full persona-style-input" placeholder="콘텐츠 생성시 적용할 스타일 가이드"></textarea>
                </div>
                <div class="persona-modal-actions">
                    <button type="button" class="save-btn secondary-btn" id="persona-cancel-btn">취소</button>
                    <button type="button" class="save-btn" id="persona-save-btn">💾 저장</button>
                </div>
            </div>
        </div>

        <div class="admin-section">
            <h2>➕ 소스 추가</h2>
            <div class="source-add-grid">
                <form id="url-add-form" class="config-card source-add-form">
                    <div class="config-row source-add-row">
                        <label class="config-key" for="source-url">웹 URL</label>
                        <input id="source-url" name="source" class="config-input" type="url" autocomplete="url" inputmode="url" placeholder="https://example.com/article" maxlength="4096" aria-describedby="source-url-hint" required>
                        <span id="source-url-hint" class="source-add-hint">공개 웹 페이지를 가져와 위키 소스로 추가합니다.</span>
                        <button type="submit" class="save-btn">URL 추가</button>
                    </div>
                    <p id="url-add-status" class="admin-status" role="status" aria-live="polite"></p>
                </form>
                <form id="file-upload-form" class="config-card source-add-form" enctype="multipart/form-data">
                    <div class="config-row source-add-row">
                        <label class="config-key" for="source-file">파일</label>
                        <input id="source-file" name="file" class="config-input" type="file" accept="${uploadAccept}" aria-describedby="source-file-hint" required>
                        <span id="source-file-hint" class="source-add-hint">${uploadHint} 파일 1개</span>
                        <button type="submit" class="save-btn">파일 추가</button>
                    </div>
                    <p id="file-upload-status" class="admin-status" role="status" aria-live="polite"></p>
                </form>
            </div>
        </div>

        <div class="admin-section">
            <h2>📚 등록된 소스 (${opts.sources.length})</h2>
            <div class="admin-table-wrap" tabindex="0" role="region" aria-label="등록된 소스 표">
            <table class="admin-table">
                <caption class="visually-hidden">등록된 소스 ${opts.sources.length}개</caption>
                <thead><tr><th scope="col">ID</th><th scope="col">타입</th><th scope="col">제목</th><th scope="col">URI</th><th scope="col">등록일</th></tr></thead>
                <tbody>${sourceRows || '<tr><td colspan="5" class="admin-empty-row">소스가 없습니다</td></tr>'}</tbody>
            </table>
            </div>
        </div>

        <div class="admin-section">
            <h2>🔧 작업</h2>
            <div class="config-card config-card-actions">
                <button type="button" class="save-btn" id="btn-build">🔨 사이트 빌드</button>
                <span id="action-status" class="admin-status" role="status" aria-live="polite"></span>
            </div>
        </div>

        <div class="admin-section">
            <h2>📄 지원 파일 형식</h2>
            <div class="config-card">
                <div class="config-row"><span class="config-key">URL</span><span class="config-value">웹 페이지 크롤링</span></div>
                ${uploadFormatRows}
            </div>
        </div>
    </main>
    <script id="kiwi-personas-data" type="application/json">${JSON.stringify(opts.personas).replace(/</g, "\\u003c")}</script>
    <script src="/static/admin.js"></script>
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
  seo?: SiteSeo;
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
        <label class="visually-hidden" for="catalog-search">문서 이름으로 필터링</label>
        <input type="search" id="catalog-search" placeholder="문서 이름으로 검색…" autocomplete="off" aria-controls="catalog-categories" aria-describedby="catalog-filter-status">
        <p id="catalog-filter-status" class="catalog-filter-status" role="status" aria-live="polite" data-default-text="전체 ${opts.totalPages}개 문서">전체 ${opts.totalPages}개 문서</p>
    </div>

    <div id="catalog-categories">
        ${categoriesHtml || '<p class="catalog-empty">아직 문서가 없습니다. 소스를 추가하면 자동으로 목록이 생성됩니다.</p>'}
        <p class="catalog-empty" id="catalog-no-results" hidden>검색어와 일치하는 문서가 없습니다.</p>
    </div>
</div>
<script src="/static/catalog.js"></script>`;

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
    seo: opts.seo,
    route: "/catalog.html",
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
  seo?: SiteSeo;
}): string {
  const totalCitations = opts.coverage.reduce((s, c) => s + c.citationCount, 0);
  const totalSourcesCited = opts.coverage.filter(c => c.citationCount > 0).length;

  const rows = opts.coverage.map(c => {
    const pageLinks = c.pages.map(p =>
      `<a href="/wiki/${p.slug}.html" class="provenance-page-link">${escapeHtml(p.title)}</a>`
    ).join(", ") || '<span class="text-muted">-</span>';

    const barWidth = totalCitations > 0 ? Math.max(2, Math.round((c.citationCount / totalCitations) * 100)) : 0;
    const barTone = c.citationCount === 0 ? 'empty' : c.citationCount < 3 ? 'partial' : 'strong';

    return `<tr>
      <th scope="row">${escapeHtml(c.sourceTitle || 'Untitled')}</th>
      <td class="text-center">${c.citationCount}</td>
      <td class="text-center">${c.pageCount}</td>
      <td><progress class="provenance-bar ${barTone}" aria-label="${escapeHtml(c.sourceTitle || '제목 없음')} 인용 비중" max="100" value="${barWidth}"></progress></td>
      <td class="provenance-pages">${pageLinks}</td>
    </tr>`;
  }).join("\n");

  const content = `
<div class="provenance-page">
  <h1>📚 출처 추적</h1>
  <p class="provenance-summary">
    전체 ${opts.coverage.length}개 소스 중 ${totalSourcesCited}개에서 ${totalCitations}건의 인용을 확인했습니다.
  </p>

  <div class="provenance-table-wrap" tabindex="0" role="region" aria-label="소스별 인용 현황 표">
  <table class="provenance-table">
    <caption class="visually-hidden">소스별 인용 및 연결 문서 현황</caption>
    <thead>
      <tr>
        <th scope="col">소스</th>
        <th scope="col" class="text-center">인용</th>
        <th scope="col" class="text-center">문서</th>
        <th scope="col">인용 비중</th>
        <th scope="col">인용한 문서</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="5" class="provenance-empty">아직 추적할 소스가 없습니다.</td></tr>'}
    </tbody>
  </table>
  </div>

  ${opts.coverage.some(c => c.citationCount === 0) ? `
  <div class="provenance-warning" role="note">
    <strong>인용되지 않은 소스:</strong>
    ${opts.coverage.filter(c => c.citationCount === 0).map(c => escapeHtml(c.sourceTitle || 'Untitled')).join(", ")}
    <br><small><code>kiwimu cite</code>를 실행하면 기존 콘텐츠의 인용을 생성할 수 있습니다.</small>
  </div>` : ''}
</div>

<style>
.provenance-page { max-width: 960px; margin: 0 auto; }
.provenance-page h1 { margin-bottom: 8px; }
.provenance-summary { color: var(--text-muted); margin-bottom: 24px; }
.provenance-table-wrap { width: 100%; overflow-x: auto; border: 1px solid var(--border); }
.provenance-table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 14px; }
.provenance-table th, .provenance-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; }
.provenance-table th { font-weight: 600; background: var(--bg-alt, #f8f9fa); }
.text-center { text-align: center !important; }
.text-muted { color: var(--text-muted, #999); }
.provenance-bar { appearance: none; width: 100%; min-width: 100px; height: 8px; overflow: hidden; border: 0; border-radius: 4px; background: var(--bg-hover); }
.provenance-bar::-webkit-progress-bar { background: var(--bg-hover); }
.provenance-bar.empty::-webkit-progress-value { background: var(--border); }
.provenance-bar.partial::-webkit-progress-value { background: #b36b00; }
.provenance-bar.strong::-webkit-progress-value { background: var(--namu-green); }
.provenance-bar.empty::-moz-progress-bar { background: var(--border); }
.provenance-bar.partial::-moz-progress-bar { background: #b36b00; }
.provenance-bar.strong::-moz-progress-bar { background: var(--namu-green); }
.provenance-pages { font-size: 12px; }
.provenance-page-link { display: inline-block; margin: 2px 4px 2px 0; padding: 1px 6px; background: var(--bg-alt, #f0f0f0); border-radius: 3px; text-decoration: none; color: var(--accent-text, #006b62); }
.provenance-page-link:hover { background: var(--control-bg, #006b62); color: white; }
.provenance-warning { margin-top: 24px; padding: 12px 16px; background: var(--warning-bg, #fff8e1); color: var(--text); border: 1px solid var(--warning-border, #b36b00); border-radius: 6px; font-size: 13px; }
.provenance-empty { padding: 32px !important; text-align: center !important; color: var(--text-muted); }
</style>`;

  return base({
    title: `Source Provenance - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    content,
    categories: opts.categories,
    seo: opts.seo,
    route: "/provenance.html",
  });
}

export function renderActivityPage(
  wikiName: string,
  stats: { total: number; byAction: Record<string, number>; recentDays: { date: string; count: number }[] }
): string {
  const actionIcons: Record<string, string> = {
    ingest: "\u{1F4E5}", page_created: "\u{1F4C4}", page_updated: "\u270F\uFE0F", quiz_generated: "\u{1F9E9}",
    quiz_attempted: "\u{1F4DD}", query: "\u2753", build: "\u{1F528}", deploy: "\u{1F680}", expand: "\u{1F9E0}",
  };
  const actionLabels: Record<string, string> = {
    ingest: "수집", page_created: "문서 생성", page_updated: "문서 수정",
    quiz_generated: "퀴즈 생성", quiz_attempted: "퀴즈 풀이", query: "질문",
    build: "사이트 빌드", deploy: "배포", expand: "콘텐츠 확장",
  };
  const filterButtons = Object.entries(stats.byAction)
    .map(([action, count]) => `<button type="button" class="filter-btn" data-action="${escapeHtml(action)}" aria-pressed="false">${actionIcons[action] || "\u{1F4CC}"} ${escapeHtml(actionLabels[action] || action)} <span class="count">(${count})</span></button>`)
    .join("\n          ");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>활동 기록 - ${escapeHtml(wikiName)}</title>
  <meta name="description" content="${escapeHtml(wikiName)}의 최근 활동 기록">
  <style>
    :root { --bg: #fff; --fg: #1a1a2e; --card-bg: #f8f9fa; --border: #e0e0e0; --accent: #005ea8; --muted: #6c757d; --badge-bg: #e8f0fe; --badge-fg: #005ea8; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #1a1a2e; --fg: #e0e0e0; --card-bg: #16213e; --border: #2a2a4a; --accent: #8ac7ff; --muted: #9e9e9e; --badge-bg: #1e3a5f; --badge-fg: #b8dcff; }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; }
    .container { max-width: 860px; margin: 0 auto; padding: 2rem 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: var(--muted); margin-bottom: 1.5rem; }
    .filters { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1.5rem; }
    .filter-btn { min-height: 40px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 1rem; padding: 0.45rem 0.8rem; cursor: pointer; font-size: 0.85rem; color: var(--fg); transition: background 0.15s, color 0.15s, border-color 0.15s; }
    .filter-btn:hover, .filter-btn.active { background: var(--badge-bg); color: var(--badge-fg); border-color: var(--accent); }
    .filter-btn .count { color: var(--muted); font-size: 0.75rem; }
    .timeline { list-style: none; border-left: 2px solid var(--border); padding-left: 1.5rem; }
    .timeline-item { position: relative; padding: 0.75rem 0; }
    .timeline-item::before { content: ""; position: absolute; left: -1.75rem; top: 1.1rem; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
    .timeline-item .time { font-size: 0.75rem; color: var(--muted); }
    .timeline-item .badge { display: inline-block; background: var(--badge-bg); color: var(--badge-fg); font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 0.75rem; margin-left: 0.5rem; }
    .timeline-item .title { font-weight: 500; margin-top: 0.15rem; }
    .timeline-item .details { font-size: 0.8rem; color: var(--muted); margin-top: 0.15rem; }
    .load-more { display: block; width: 100%; min-height: 44px; padding: 0.6rem; margin-top: 1rem; background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; cursor: pointer; color: var(--fg); font-size: 0.9rem; text-align: center; }
    .load-more:disabled { opacity: .65; cursor: wait; }
    .load-more:hover { background: var(--badge-bg); }
    .empty { text-align: center; color: var(--muted); padding: 3rem; }
    a.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
    a.back:hover { text-decoration: underline; }
    :focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 5px #005fcc; }
    @media (forced-colors: active) { :focus-visible { outline: 3px solid Highlight; box-shadow: none; } }
    .activity-status { min-height: 1.5rem; color: var(--muted); font-size: .85rem; margin-top: .75rem; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
  </style>
</head>
<body>
  <main class="container" id="main-content">
    <nav aria-label="돌아가기"><a class="back" href="/">&larr; 위키로 돌아가기</a></nav>
    <h1>활동 기록</h1>
    <p class="subtitle">전체 ${stats.total}개 이벤트</p>
    <div class="filters" aria-label="활동 유형 필터">
      <button type="button" class="filter-btn active" data-action="" aria-pressed="true">전체 (${stats.total})</button>
      ${filterButtons}
    </div>
    <ul class="timeline" id="timeline" aria-label="활동 타임라인" aria-busy="true"></ul>
    <button type="button" class="load-more" id="load-more">더 보기</button>
    <div class="empty" id="empty" role="status" hidden>아직 활동이 없습니다.</div>
    <p class="activity-status" id="activity-status" role="status" aria-live="polite">활동을 불러오는 중…</p>
  </main>
  <script src="/static/activity.js"></script>
</body>
</html>`;
}
