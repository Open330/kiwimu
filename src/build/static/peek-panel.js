/*
 * peek-panel.js — Notion-style side-panel preview for /wiki/* links.
 * Intercepts plain-clicks, fetches the generated /wiki/{slug}.html document,
 * and renders its page body in a slide-in panel. Reading the static document
 * keeps previews working on GitHub Pages and for unauthenticated visitors as
 * well as on the live server.
 */
(function () {
  'use strict';

  if (window.__kiwiPeekInit) return;
  window.__kiwiPeekInit = true;

  const WIKI_LINK_RE = /^\/wiki\/([^/?#]+)\.html(?:[?#].*)?$/;
  const STACK_LIMIT = 5;
  const WIDTH_KEY = 'kiwi-peek-width';
  const WIDTH_MIN = 320;
  const WIDTH_MAX_VW = 0.95;
  const WIDTH_STEPS = [320, 400, 480, 560, 640, 720, 800, 960, 1120, 1280, 1400];

  // --- State ---------------------------------------------------------------
  let panel, backdrop, titleEl, contentEl, statusEl, resizeHandle, backBtn, expandBtn;
  let titleId;
  const stack = [];               // previous slugs for "back"
  let currentSlug = null;
  let isOpen = false;
  let lastFocused = null;
  let abortCtrl = null;
  let pushedHistoryState = false; // did we push the current ?peek state?

  // --- Resize --------------------------------------------------------------
  function clampWidth(w) {
    const max = Math.min(window.innerWidth * WIDTH_MAX_VW, 1400);
    return Math.max(WIDTH_MIN, Math.min(max, w));
  }
  function loadSavedWidth() {
    try {
      const v = parseInt(localStorage.getItem(WIDTH_KEY) || '', 10);
      return v > 0 ? clampWidth(v) : null;
    } catch { return null; }
  }
  function saveWidth(w) {
    try { localStorage.setItem(WIDTH_KEY, String(Math.round(w))); } catch { /* no-op */ }
  }
  function widthStep(w) {
    return WIDTH_STEPS.reduce((nearest, candidate) =>
      Math.abs(candidate - w) < Math.abs(nearest - w) ? candidate : nearest
    , WIDTH_STEPS[0]);
  }
  function applyWidth(w) {
    WIDTH_STEPS.forEach((step) => panel.classList.remove('peek-width-' + step));
    if (!w) {
      resizeHandle?.removeAttribute('aria-valuenow');
      return null;
    }
    const step = widthStep(clampWidth(w));
    panel.classList.add('peek-width-' + step);
    resizeHandle?.setAttribute('aria-valuenow', String(step));
    return step;
  }
  function applySavedWidth() {
    // Skip on mobile — CSS forces full-screen there.
    if (window.matchMedia('(max-width: 768px)').matches) return;
    const w = loadSavedWidth();
    if (w) applyWidth(w);
  }
  function attachResizeHandle(handle) {
    let dragging = false;
    let startX = 0;
    let startW = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (window.matchMedia('(max-width: 768px)').matches) return;
      dragging = true;
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('peek-resizing');
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // Panel is anchored to the right edge — moving handle left grows width.
      const w = clampWidth(startW + (startX - e.clientX));
      applyWidth(w);
    });
    function stop(e) {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
      document.body.classList.remove('peek-resizing');
      saveWidth(panel.getBoundingClientRect().width);
    }
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('dblclick', () => {
      // Reset to default on double-click.
      applyWidth(null);
      try { localStorage.removeItem(WIDTH_KEY); } catch { /* no-op */ }
    });
    handle.addEventListener('keydown', (event) => {
      if (window.matchMedia('(max-width: 768px)').matches) return;
      const current = panel.getBoundingClientRect().width;
      let next = null;
      if (event.key === 'ArrowLeft') next = current + 80;
      else if (event.key === 'ArrowRight') next = current - 80;
      else if (event.key === 'Home') next = WIDTH_MIN;
      else if (event.key === 'End') next = Math.min(window.innerWidth * WIDTH_MAX_VW, 1400);
      if (next === null) return;
      event.preventDefault();
      const applied = applyWidth(next);
      if (applied) saveWidth(applied);
    });
  }

  // --- DOM construction ----------------------------------------------------
  function build() {
    titleId = 'peek-title-' + Math.random().toString(36).slice(2, 9);

    backdrop = document.createElement('div');
    backdrop.className = 'peek-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', () => close());

    panel = document.createElement('aside');
    panel.className = 'peek-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', titleId);
    panel.setAttribute('tabindex', '-1');
    panel.hidden = true;

    resizeHandle = document.createElement('div');
    resizeHandle.className = 'peek-resize-handle';
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-orientation', 'vertical');
    resizeHandle.setAttribute('aria-label', '미리보기 너비 조절');
    resizeHandle.setAttribute('aria-valuemin', String(WIDTH_MIN));
    resizeHandle.setAttribute('aria-valuemax', String(Math.min(window.innerWidth * WIDTH_MAX_VW, 1400)));
    resizeHandle.tabIndex = 0;
    resizeHandle.title = '드래그하여 너비 조절 · 더블클릭으로 초기화';
    attachResizeHandle(resizeHandle);
    panel.appendChild(resizeHandle);

    const headerEl = document.createElement('header');
    headerEl.className = 'peek-header';

    backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'peek-button peek-back';
    backBtn.setAttribute('aria-label', '이전 미리보기');
    backBtn.textContent = '←';
    backBtn.hidden = true;
    backBtn.addEventListener('click', goBack);

    titleEl = document.createElement('h2');
    titleEl.className = 'peek-title';
    titleEl.id = titleId;
    titleEl.textContent = '문서 미리보기';

    const actions = document.createElement('div');
    actions.className = 'peek-actions';

    expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'peek-button peek-expand';
    expandBtn.setAttribute('aria-label', '전체 문서 열기');
    expandBtn.title = '전체 문서 열기';
    expandBtn.textContent = '↗';
    expandBtn.addEventListener('click', () => {
      if (currentSlug) {
        // Plain navigation in same tab.
        window.location.href = '/wiki/' + encodeURIComponent(currentSlug) + '.html';
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'peek-button peek-close';
    closeBtn.setAttribute('aria-label', '미리보기 닫기');
    closeBtn.title = '미리보기 닫기';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => close());

    actions.append(expandBtn, closeBtn);
    headerEl.append(backBtn, titleEl, actions);

    contentEl = document.createElement('div');
    contentEl.className = 'peek-content';
    statusEl = document.createElement('p');
    statusEl.className = 'visually-hidden';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.setAttribute('aria-atomic', 'true');

    panel.append(headerEl, statusEl, contentEl);

    document.body.append(backdrop, panel);
  }

  // --- Open / close lifecycle ---------------------------------------------
  function lockBodyScroll() {
    document.body.classList.add('peek-panel-open');
  }
  function unlockBodyScroll() {
    document.body.classList.remove('peek-panel-open');
  }

  function setUrlPeek(slug) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('peek', slug);
      if (pushedHistoryState) {
        history.replaceState({ kiwiPeek: slug }, '', url.toString());
      } else {
        history.pushState({ kiwiPeek: slug }, '', url.toString());
        pushedHistoryState = true;
      }
    } catch { /* no-op */ }
  }

  function clearUrlPeek() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('peek')) return;
      url.searchParams.delete('peek');
      const target = url.pathname + (url.search ? url.search : '') + url.hash;
      if (pushedHistoryState) {
        // Step back through history so we restore the original entry.
        pushedHistoryState = false;
        history.back();
      } else {
        history.replaceState({}, '', target);
      }
    } catch { /* no-op */ }
  }

  function open(slug, opts) {
    opts = opts || {};
    if (!slug) return;

    if (!isOpen) {
      lastFocused = document.activeElement;
      applySavedWidth();
      panel.hidden = false;
      if (!resizeHandle.hasAttribute('aria-valuenow')) {
        resizeHandle.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
      }
      backdrop.classList.add('is-open');
      // Force layout so the transform transition runs.
      // eslint-disable-next-line no-unused-expressions
      panel.offsetWidth;
      panel.classList.add('is-open');
      lockBodyScroll();
      isOpen = true;
    }

    if (opts.resetStack) {
      stack.length = 0;
    }
    if (opts.pushOnto && currentSlug && currentSlug !== slug) {
      stack.push(currentSlug);
      while (stack.length > STACK_LIMIT) stack.shift();
    }

    currentSlug = slug;
    backBtn.hidden = stack.length === 0;

    if (!opts.skipUrl) setUrlPeek(slug);

    fetchAndRender(slug);

    // Focus the panel after open so keyboard users land inside.
    requestAnimationFrame(() => {
      panel.focus({ preventScroll: true });
    });
  }

  function close(opts) {
    opts = opts || {};
    if (!isOpen) return;
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }

    panel.classList.remove('is-open');
    backdrop.classList.remove('is-open');
    // Hide after transition (250ms) for a11y; cheap timeout is fine.
    setTimeout(() => { if (!isOpen) panel.hidden = true; }, 280);

    isOpen = false;
    currentSlug = null;
    stack.length = 0;
    backBtn.hidden = true;
    unlockBodyScroll();

    if (!opts.skipUrl) clearUrlPeek();

    if (lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus({ preventScroll: true }); } catch { /* no-op */ }
    }
    lastFocused = null;
  }

  function goBack() {
    if (stack.length === 0) { close(); return; }
    const prev = stack.pop();
    currentSlug = prev;
    backBtn.hidden = stack.length === 0;
    setUrlPeek(prev);
    fetchAndRender(prev);
  }

  // --- Fetch + render ------------------------------------------------------
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function showLoading() {
    titleEl.textContent = '불러오는 중…';
    contentEl.setAttribute('aria-busy', 'true');
    statusEl.textContent = '문서 미리보기를 불러오는 중입니다.';
    contentEl.innerHTML =
      '<div class="peek-loading"><span class="peek-spinner"></span>불러오는 중…</div>';
  }

  function showError(slug, msg) {
    titleEl.textContent = '미리보기 오류';
    contentEl.setAttribute('aria-busy', 'false');
    const message = msg || '문서를 불러오지 못했습니다.';
    statusEl.textContent = message;
    const safeMsg = escapeHtml(message);
    contentEl.innerHTML =
      '<div class="peek-error">' + safeMsg +
      '<div><button type="button" class="peek-button" data-peek-retry>다시 시도</button></div>' +
      '</div>';
    const retry = contentEl.querySelector('[data-peek-retry]');
    if (retry) retry.addEventListener('click', () => fetchAndRender(slug));
  }

  async function fetchAndRender(slug) {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const ctrl = abortCtrl;

    showLoading();

    try {
      const resp = await fetch('/wiki/' + encodeURIComponent(slug) + '.html', {
        signal: ctrl.signal,
        credentials: 'same-origin'
      });
      if (!resp.ok) {
        const detail = resp.status === 404 ? '문서를 찾을 수 없습니다.' : '서버 오류가 발생했습니다 (' + resp.status + ').';
        showError(slug, detail);
        return;
      }
      const documentHtml = await resp.text();
      if (ctrl.signal.aborted) return;

      const parsed = new DOMParser().parseFromString(documentHtml, 'text/html');
      const pageBody = parsed.querySelector('.page-body');
      if (!pageBody) {
        showError(slug, '이 문서는 미리보기를 제공하지 않습니다.');
        return;
      }
      const pageHeading = parsed.querySelector('.wiki-page h1, main h1, h1');
      titleEl.textContent = pageHeading && pageHeading.textContent
        ? pageHeading.textContent.trim()
        : (parsed.title || slug);

      // Wrap in .page-body so existing article styles + dynamic-qa selection
      // gating work inside the peek panel without duplicating logic.
      contentEl.innerHTML =
        '<article class="wiki-page peek-article"><div class="page-body">' +
        pageBody.innerHTML +
        '</div></article>';
      contentEl.scrollTop = 0;
      contentEl.setAttribute('aria-busy', 'false');
      statusEl.textContent = titleEl.textContent + ' 미리보기를 불러왔습니다.';

      // Re-run local rich-content renderers for dynamically inserted markup.
      try {
        if (typeof window.kiwiRenderMath === 'function') {
          window.kiwiRenderMath(contentEl);
        }
        if (typeof window.kiwiRenderMermaid === 'function') {
          window.kiwiRenderMermaid(contentEl);
        }
      } catch { /* don't crash on mermaid errors */ }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      showError(slug, '네트워크 오류가 발생했습니다. 연결을 확인하고 다시 시도해 주세요.');
    }
  }

  // --- Link interception ---------------------------------------------------
  function isPlainLeftClick(e) {
    return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
  }

  function slugFromHref(href) {
    if (!href) return null;
    let path;
    try {
      // Resolve relative against current location.
      const u = new URL(href, window.location.href);
      // Only intercept same-origin links.
      if (u.origin !== window.location.origin) return null;
      path = u.pathname;
    } catch { return null; }
    const m = WIKI_LINK_RE.exec(path);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function onClick(e) {
    if (!isPlainLeftClick(e)) return;
    if (e.defaultPrevented) return;

    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (a.target && a.target !== '' && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    if (a.dataset && a.dataset.peek === 'off') return;

    const slug = slugFromHref(a.getAttribute('href'));
    if (!slug) return;

    e.preventDefault();

    if (isOpen) {
      // Navigating within the panel — push current onto the stack.
      open(slug, { pushOnto: true });
    } else {
      open(slug, { resetStack: true });
    }
  }

  // --- Keyboard: ESC + focus trap -----------------------------------------
  const FOCUSABLE_SEL =
    'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]),' +
    ' select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusableNodes() {
    return Array.prototype.filter.call(
      panel.querySelectorAll(FOCUSABLE_SEL),
      (el) => !el.hidden && el.offsetParent !== null
    );
  }

  function onKeydown(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;

    const nodes = focusableNodes();
    if (nodes.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      if (active === first || active === panel || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // --- History sync (back/forward) ----------------------------------------
  function onPopState() {
    const url = new URL(window.location.href);
    const slug = url.searchParams.get('peek');
    // Whatever history says — make our state match.
    pushedHistoryState = false;
    if (slug) {
      open(slug, { skipUrl: true, resetStack: true });
    } else if (isOpen) {
      close({ skipUrl: true });
    }
  }

  // --- Bootstrap -----------------------------------------------------------
  function init() {
    build();
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('popstate', onPopState);

    // Auto-open if the current URL has ?peek=<slug>.
    try {
      const url = new URL(window.location.href);
      const slug = url.searchParams.get('peek');
      if (slug) {
        // Don't push history; the URL is already correct.
        open(slug, { skipUrl: true, resetStack: true });
      }
    } catch { /* no-op */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
