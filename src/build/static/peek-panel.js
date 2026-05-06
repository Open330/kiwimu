/*
 * peek-panel.js — Notion-style side-panel preview for /wiki/* links.
 * Intercepts plain-clicks, fetches /api/page/{slug}?format=html, renders in a
 * slide-in panel with a navigation stack (cap 5), URL state (?peek=<slug>),
 * focus trap, ESC-to-close. Idempotent via window.__kiwiPeekInit.
 */
(function () {
  'use strict';

  if (window.__kiwiPeekInit) return;
  window.__kiwiPeekInit = true;

  const WIKI_LINK_RE = /^\/wiki\/([^/?#]+)\.html(?:[?#].*)?$/;
  const STACK_LIMIT = 5;

  // Auth: read token from <meta name="kiwi-auth"> (matches dynamic-qa.js).
  function authHeaders() {
    const t = document.querySelector('meta[name="kiwi-auth"]')?.content || '';
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  // --- State ---------------------------------------------------------------
  let panel, backdrop, titleEl, contentEl, backBtn, expandBtn;
  let titleId;
  const stack = [];               // previous slugs for "back"
  let currentSlug = null;
  let isOpen = false;
  let lastFocused = null;
  let savedBodyOverflow = '';
  let abortCtrl = null;
  let pushedHistoryState = false; // did we push the current ?peek state?

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

    const headerEl = document.createElement('header');
    headerEl.className = 'peek-header';

    backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'peek-button peek-back';
    backBtn.setAttribute('aria-label', 'Back');
    backBtn.textContent = '←';
    backBtn.hidden = true;
    backBtn.addEventListener('click', goBack);

    titleEl = document.createElement('h2');
    titleEl.className = 'peek-title';
    titleEl.id = titleId;
    titleEl.textContent = '';

    const actions = document.createElement('div');
    actions.className = 'peek-actions';

    expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'peek-button peek-expand';
    expandBtn.setAttribute('aria-label', 'Open full page');
    expandBtn.title = 'Open full page';
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
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => close());

    actions.append(expandBtn, closeBtn);
    headerEl.append(backBtn, titleEl, actions);

    contentEl = document.createElement('div');
    contentEl.className = 'peek-content';

    panel.append(headerEl, contentEl);

    document.body.append(backdrop, panel);
  }

  // --- Open / close lifecycle ---------------------------------------------
  function lockBodyScroll() {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  function unlockBodyScroll() {
    document.body.style.overflow = savedBodyOverflow;
    savedBodyOverflow = '';
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
      panel.hidden = false;
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
    titleEl.textContent = 'Loading…';
    contentEl.innerHTML =
      '<div class="peek-loading"><span class="peek-spinner"></span>Loading…</div>';
  }

  function showError(slug, msg) {
    titleEl.textContent = 'Error';
    const safeMsg = escapeHtml(msg || 'Failed to load page.');
    contentEl.innerHTML =
      '<div class="peek-error">' + safeMsg +
      '<div><button type="button" class="peek-button" data-peek-retry>Retry</button></div>' +
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
      const resp = await fetch(
        '/api/page/' + encodeURIComponent(slug) + '?format=html',
        { headers: authHeaders(), signal: ctrl.signal, credentials: 'same-origin' }
      );
      if (!resp.ok) {
        const detail = resp.status === 404 ? 'Page not found.' : 'Server error (' + resp.status + ').';
        showError(slug, detail);
        return;
      }
      const data = await resp.json();
      if (ctrl.signal.aborted) return;

      titleEl.textContent = data.title || slug;

      let html = data.html;
      if (!html && typeof data.content === 'string') {
        // Defensive fallback if server hasn't enabled ?format=html yet.
        html = '<pre>' + escapeHtml(data.content) + '</pre>';
      }
      contentEl.innerHTML = html || '';
      contentEl.scrollTop = 0;

      // Re-run mermaid if the host page exposes the helper.
      try {
        if (typeof window.kiwiRenderMermaid === 'function') {
          window.kiwiRenderMermaid(contentEl);
        }
      } catch { /* don't crash on mermaid errors */ }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      showError(slug, 'Network error. Check your connection and try again.');
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
