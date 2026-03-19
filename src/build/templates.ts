interface PageLink {
  slug: string;
  title: string;
  pageType?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sidebarHtml(sourcePages: PageLink[], conceptPages: PageLink[], activeSlug?: string): string {
  const sourceItems = sourcePages
    .map(
      (p) =>
        `<li><a href="/wiki/${p.slug}.html"${p.slug === activeSlug ? ' class="active"' : ""}>${escapeHtml(p.title)}</a></li>`
    )
    .join("\n");

  const conceptItems = conceptPages
    .map(
      (p) =>
        `<li><a href="/wiki/${p.slug}.html"${p.slug === activeSlug ? ' class="active"' : ""}>${escapeHtml(p.title)}</a></li>`
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
            </div>`;
}

function base(opts: {
  title: string;
  wikiName: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  activeSlug?: string;
  content: string;
}) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(opts.title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/style.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
</head>
<body>
    <nav class="topbar">
        <button class="topbar-menu-btn" aria-label="메뉴">☰</button>
        <a href="/index.html" class="topbar-brand">
            <img src="/static/logo.png" alt="Kiwi Mu" class="topbar-logo">
            ${escapeHtml(opts.wikiName)}
        </a>
        <div class="topbar-search">
            <input type="text" id="search-input" placeholder="문서 검색..." autocomplete="off">
            <div id="search-results" class="search-dropdown"></div>
        </div>
        <div class="topbar-links">
            <a href="/wiki/random.html" style="color:#fff;text-decoration:none;font-size:13px;">🎲 임의</a>
            <a href="/graph.html" class="btn-graph">📊 그래프</a>
            <a href="/admin" class="btn-graph">⚙️ 관리</a>
        </div>
    </nav>
    <div class="sidebar-overlay"></div>
    <div class="layout">
        <aside class="sidebar">
            ${sidebarHtml(opts.sourcePages, opts.conceptPages, opts.activeSlug)}
        </aside>
        <main class="content">
            ${opts.content}
        </main>
    </div>
    <script src="/static/search.js"></script>
    <script>
        // Mobile hamburger menu
        (function() {
            const menuBtn = document.querySelector('.topbar-menu-btn');
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.querySelector('.sidebar-overlay');
            if (menuBtn && sidebar) {
                menuBtn.addEventListener('click', () => {
                    sidebar.classList.toggle('open');
                    overlay?.classList.toggle('active');
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
        // KaTeX
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
  pageType: string;
  content: string;
  externalRefs: string;
  toc: string;
  backlinks: PageLink[];
  sourcePages: PageLink[];
  conceptPages: PageLink[];
}): string {
  const typeLabel = opts.pageType === "source" ? "📖 원본 문서" : "📝 개념 문서";
  const typeBadge = `<span class="page-type-badge ${opts.pageType}">${typeLabel}</span>`;

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

  const content = `
<article class="wiki-page">
    <header class="page-header">
        ${typeBadge}
        <h1>${escapeHtml(opts.pageTitle)}</h1>
    </header>
    ${tocHtml}
    <div class="page-body">${opts.content}</div>
    ${externalRefsHtml}
    ${backlinksHtml}
</article>`;

  return base({
    title: `${opts.pageTitle} - ${opts.wikiName}`,
    wikiName: opts.wikiName,
    sourcePages: opts.sourcePages,
    conceptPages: opts.conceptPages,
    activeSlug: opts.pageSlug,
    content,
  });
}

export function renderIndex(opts: {
  wikiName: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
  sourceCount: number;
}): string {
  const sourceCards = opts.sourcePages
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
            <p>문서를 추가하려면 <a href="/admin">관리 페이지</a>에서 문서를 추가하세요.</p>
        </section>

        <section class="index-section">
            <h2>📖 원본 문서</h2>
            <div class="page-cards">${sourceCards.length > 0 ? sourceCards : '<div class="empty-state">아직 원본 문서가 없습니다. URL이나 파일을 추가해보세요!</div>'}</div>
        </section>
        <section class="index-section">
            <h2>📝 개념 문서</h2>
            <div class="page-cards">${conceptCards.length > 0 ? conceptCards : '<div class="empty-state">아직 개념 문서가 없습니다. 원본 문서를 추가하면 자동으로 생성됩니다.</div>'}</div>
        </section>
        <section class="index-section">
            <div class="quick-links">
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
    content,
  });
}

export function renderGraph(opts: {
  wikiName: string;
  sourcePages: PageLink[];
  conceptPages: PageLink[];
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
            <a href="/admin" class="btn-graph" style="border-color: var(--accent);">⚙️ 관리</a>
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
                    <input id="llm-model" class="config-input" value="${escapeHtml(opts.llmConfig.model)}" placeholder="gemini-2.0-flash-lite">
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
        const models = { gemini: 'gemini-2.0-flash-lite', 'azure-openai': 'gpt-5-nano', openai: 'gpt-4o-mini', anthropic: 'claude-sonnet-4-20250514' };
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
