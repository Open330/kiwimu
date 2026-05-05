(function() {
  'use strict';

  const authToken = document.querySelector('meta[name="kiwi-auth"]')?.content;
  if (!authToken) return; // Static build — feature disabled

  const pageSlug = document.querySelector('[data-page-slug]')?.dataset.pageSlug;
  const pageId = document.querySelector('[data-page-id]')?.dataset.pageId;
  if (!pageSlug || !pageId) return; // Not a wiki page

  // Create popover element
  const popover = document.createElement('div');
  popover.className = 'qa-popover';
  popover.innerHTML = `
    <div class="qa-popover-header">
      <span>📝 새 개념 페이지 생성</span>
      <button class="qa-popover-close" aria-label="닫기">&times;</button>
    </div>
    <div class="qa-popover-selected"></div>
    <div class="qa-popover-related" style="display:none">
      <div class="qa-related-label">📚 관련 문서</div>
      <div class="qa-related-list"></div>
    </div>
    <div class="qa-popover-body">
      <div class="qa-body-row">
        <input type="text" class="qa-popover-input" placeholder="질문 입력 (선택사항)..." />
      </div>
      <div class="qa-body-row">
        <button class="qa-popover-btn qa-generate-btn">✨ 개념 페이지 생성</button>
      </div>
    </div>
    <div class="qa-popover-loading" style="display:none">
      <span class="qa-spinner"></span> 생성 중...
    </div>
    <div class="qa-popover-result" style="display:none"></div>
    <div class="qa-popover-error" style="display:none"></div>
  `;
  document.body.appendChild(popover);

  const generateBtn = popover.querySelector('.qa-generate-btn');
  const loading = popover.querySelector('.qa-popover-loading');
  const result = popover.querySelector('.qa-popover-result');
  const errorDiv = popover.querySelector('.qa-popover-error');
  const selectedDiv = popover.querySelector('.qa-popover-selected');
  const questionInput = popover.querySelector('.qa-popover-input');
  let selectedText = '';
  let isGenerating = false;
  let highlightMark = null;
  let popoverTimer = null;

  popover.querySelector('.qa-popover-close').addEventListener('click', hidePopover);

  // Enter key in question input triggers generate
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      generateConcept();
    }
  });

  function highlightSelection(range) {
    try {
      removeHighlight();
      highlightMark = document.createElement('mark');
      highlightMark.className = 'qa-highlight';
      range.surroundContents(highlightMark);
    } catch {
      highlightMark = null;
    }
  }

  function removeHighlight() {
    if (highlightMark && highlightMark.parentNode) {
      const parent = highlightMark.parentNode;
      while (highlightMark.firstChild) {
        parent.insertBefore(highlightMark.firstChild, highlightMark);
      }
      parent.removeChild(highlightMark);
      highlightMark = null;
    }
  }

  function showPopover(text, rect, range) {
    selectedText = text;
    loading.style.display = 'none';
    result.style.display = 'none';
    errorDiv.style.display = 'none';
    popover.querySelector('.qa-popover-body').style.display = 'flex';
    popover.querySelector('.qa-popover-header').style.display = 'flex';

    // Show selected text preview (truncated)
    const preview = text.length > 100 ? text.slice(0, 100) + '...' : text;
    selectedDiv.textContent = `"${preview}"`;
    selectedDiv.style.display = 'block';

    // Highlight selected text in the document
    highlightSelection(range);

    // Fetch related pages
    const relatedDiv = popover.querySelector('.qa-popover-related');
    const relatedList = popover.querySelector('.qa-related-list');
    relatedDiv.style.display = 'none';
    relatedList.innerHTML = '';

    fetch(`/api/search?q=${encodeURIComponent(text.slice(0, 100))}&token=${authToken}`)
      .then(r => r.json())
      .then(data => {
        if (data.results && data.results.length > 0) {
          relatedList.innerHTML = data.results.map(r => {
            const icon = r.origin === 'user' ? '💬' : r.page_type === 'source' ? '📖' : '📝';
            const preview = r.preview ? r.preview.slice(0, 80) + '...' : '';
            return `<a href="/wiki/${encodeURIComponent(r.slug)}.html" class="qa-related-item">
              <span class="qa-related-icon">${icon}</span>
              <span class="qa-related-title">${esc(r.title)}</span>
              <span class="qa-related-preview">${esc(preview)}</span>
            </a>`;
          }).join('');
          relatedDiv.style.display = 'block';
        }
      })
      .catch(() => {}); // Silently fail

    // Position below selection
    const top = rect.bottom + window.scrollY + 8;
    const left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 320));
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';
    popover.style.display = 'block';
  }

  function hidePopover() {
    popover.style.display = 'none';
    selectedText = '';
    selectedDiv.style.display = 'none';
    removeHighlight();
    clearTimeout(popoverTimer);
    popoverTimer = null;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  async function generateConcept() {
    if (isGenerating || !selectedText) return;

    isGenerating = true;
    popover.querySelector('.qa-popover-body').style.display = 'none';
    loading.style.display = 'flex';
    errorDiv.style.display = 'none';

    try {
      // Start background generation
      const resp = await fetch('/api/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({
          selected_text: selectedText,
          question: questionInput.value.trim() || undefined,
          page_slug: pageSlug,
          page_id: parseInt(pageId)
        })
      });

      const data = await resp.json();

      if (data.task_id) {
        // Background task started — poll for completion
        pollForResult(data.task_id);
      } else if (data.ok) {
        // Synchronous result (fallback)
        showResult(data);
      } else {
        showError(data.error || '오류가 발생했습니다');
      }
    } catch (e) {
      showError('서버 연결에 실패했습니다');
    }
  }

  async function pollForResult(taskId) {
    const maxAttempts = 60; // 60 * 2s = 2 min max
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const resp = await fetch(`/api/ask/status?task_id=${taskId}`, {
          headers: { 'Authorization': 'Bearer ' + authToken }
        });
        const data = await resp.json();

        if (data.status === 'completed') {
          showResult(data.result);
          return;
        } else if (data.status === 'error') {
          showError(data.error || '생성 중 오류가 발생했습니다');
          return;
        }
        // status === 'processing' — continue polling
        loading.querySelector('span:last-child')?.remove();
        const dots = '.'.repeat((i % 3) + 1);
        loading.innerHTML = `<span class="qa-spinner"></span> 생성 중${dots}`;
      } catch {
        // Network error during poll — keep trying
      }
    }
    showError('생성 시간이 초과되었습니다. 나중에 다시 시도해주세요.');
  }

  function showResult(data) {
    loading.style.display = 'none';
    isGenerating = false;

    let html = `<a href="${data.url}" class="qa-result-link">📝 ${esc(data.title)}</a><span class="qa-result-hint">새 개념 페이지가 생성되었습니다</span>`;

    // Show "Save to Wiki" button if the answer is promotable
    if (data.isPromotable) {
      html += `<button class="qa-promote-btn" title="퀴즈와 위키 링크가 포함된 영구 페이지로 저장합니다">💾 위키에 저장</button>`;
    }

    result.innerHTML = html;
    result.style.display = 'block';

    // Attach promote handler
    const promoteBtn = result.querySelector('.qa-promote-btn');
    if (promoteBtn) {
      promoteBtn.addEventListener('click', () => promoteToWiki(data));
    }

    // Replace highlight with a link to the new page
    if (highlightMark && highlightMark.parentNode) {
      const link = document.createElement('a');
      link.href = data.url;
      link.textContent = highlightMark.textContent;
      link.className = 'wiki-link dynamic-link';
      link.title = '📝 ' + data.title;
      highlightMark.parentNode.replaceChild(link, highlightMark);
      highlightMark = null;
    }
  }

  async function promoteToWiki(data) {
    const promoteBtn = result.querySelector('.qa-promote-btn');
    if (promoteBtn) {
      promoteBtn.disabled = true;
      promoteBtn.textContent = '⏳ 저장 중...';
    }

    try {
      const resp = await fetch('/api/promote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({
          question: data.question || '',
          answer: data.content || '',
          title: data.suggestedTitle || data.title,
          sourcePageId: data.sourcePageId || parseInt(pageId),
          selectedText: data.selectedText || selectedText,
        })
      });

      const promoteData = await resp.json();

      if (promoteData.ok) {
        if (promoteBtn) {
          promoteBtn.remove();
        }
        const notice = document.createElement('div');
        notice.className = 'qa-promote-success';
        const statusText = promoteData.updated ? '기존 페이지에 내용 추가됨' : '위키 페이지로 저장됨 (퀴즈 포함)';
        notice.innerHTML = `<span>✅ ${esc(statusText)}</span> <a href="${promoteData.url}">→ ${esc(promoteData.title)}</a>`;
        result.appendChild(notice);

        const toastMsg = promoteData.updated ? '위키 페이지가 업데이트되었습니다' : '위키 페이지가 추가되었습니다';
        showToast(toastMsg, 'success', { href: promoteData.url, label: promoteData.title });

        if (!promoteData.updated && promoteData.slug) {
          injectSidebarEntry(promoteData.slug, promoteData.title);
        }
      } else {
        if (promoteBtn) {
          promoteBtn.disabled = false;
          promoteBtn.textContent = '💾 위키에 저장';
        }
        showToast(promoteData.error || '저장에 실패했습니다', 'error');
      }
    } catch {
      if (promoteBtn) {
        promoteBtn.disabled = false;
        promoteBtn.textContent = '💾 위키에 저장';
      }
      showToast('서버 연결에 실패했습니다', 'error');
    }
  }

  function showToast(msg, kind, link) {
    const existing = document.querySelector('.kiwi-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'kiwi-toast ' + (kind === 'error' ? 'error' : 'success');
    const icon = kind === 'error' ? '⚠️' : '✅';
    let inner = `<span class="kiwi-toast-icon">${icon}</span><span class="kiwi-toast-text">${esc(msg)}</span>`;
    if (link && link.href) {
      inner += ` <a class="kiwi-toast-link" href="${link.href}">→ ${esc(link.label || '바로가기')}</a>`;
    }
    toast.innerHTML = inner;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 3500);
  }

  function injectSidebarEntry(slug, title) {
    const conceptList = document.querySelector('#tab-concept .page-list');
    if (!conceptList) return;
    if (conceptList.querySelector(`a[href="/wiki/${CSS.escape(slug)}.html"]`)) return;

    const li = document.createElement('li');
    li.className = 'sidebar-new-entry';
    li.innerHTML = `<a href="/wiki/${esc(slug)}.html">💬 ${esc(title)}</a>`;
    conceptList.prepend(li);

    const conceptTab = document.querySelector('.sidebar-tab[data-tab="concept"]');
    if (conceptTab) {
      const m = conceptTab.textContent.match(/\((\d+)\)/);
      if (m) {
        conceptTab.textContent = conceptTab.textContent.replace(/\(\d+\)/, `(${parseInt(m[1]) + 1})`);
      }
    }
  }

  function showError(msg) {
    loading.style.display = 'none';
    isGenerating = false;
    errorDiv.textContent = msg;
    errorDiv.style.display = 'block';
    // Show retry button
    popover.querySelector('.qa-popover-body').style.display = 'flex';
  }

  // Event: text selection with 500ms delay
  document.addEventListener('mouseup', (e) => {
    if (popover.contains(e.target)) return;

    clearTimeout(popoverTimer);

    const selection = window.getSelection();
    const text = selection?.toString().trim();

    if (!text || text.length < 3) {
      if (!popover.contains(e.target) && result.style.display !== 'block') {
        setTimeout(() => {
          if (!popover.contains(document.activeElement)) hidePopover();
        }, 200);
      }
      return;
    }

    // Check if selection is within .page-body
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const pageBody = ancestor.nodeType === 1
      ? ancestor.closest('.page-body')
      : ancestor.parentElement?.closest('.page-body');
    if (!pageBody) return;

    // Delay popover by 500ms to allow editing the selection
    const savedRange = range.cloneRange();
    const savedRect = range.getBoundingClientRect();
    popoverTimer = setTimeout(() => {
      // Verify selection still exists after delay
      const currentSelection = window.getSelection();
      const currentText = currentSelection?.toString().trim();
      if (currentText && currentText.length >= 3) {
        showPopover(currentText, savedRect, savedRange);
      }
    }, 500);
  });

  // Mobile: use selectionchange with debounce (already has delay)
  let selectionTimer;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (!text || text.length < 3) return;

      const range = selection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const pageBody = ancestor.nodeType === 1
        ? ancestor.closest('.page-body')
        : ancestor.parentElement?.closest('.page-body');
      if (!pageBody) return;

      showPopover(text, range.getBoundingClientRect(), range.cloneRange());
    }, 800); // Slightly longer delay for mobile
  });

  // Event: generate button
  generateBtn.addEventListener('click', generateConcept);

  // Event: Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePopover();
  });

  // Prevent popover clicks from dismissing
  popover.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
})();
