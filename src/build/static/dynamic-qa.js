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
      <span>💬 이 부분에 대해 질문하기</span>
      <button class="qa-popover-close" aria-label="닫기">&times;</button>
    </div>
    <div class="qa-popover-selected"></div>
    <div class="qa-popover-body">
      <input type="text" class="qa-popover-input" placeholder="궁금한 점을 입력하세요..." />
      <button class="qa-popover-btn">질문</button>
    </div>
    <div class="qa-popover-loading" style="display:none">
      <span class="qa-spinner"></span> 답변 생성 중...
    </div>
    <div class="qa-popover-result" style="display:none"></div>
    <div class="qa-popover-error" style="display:none"></div>
  `;
  document.body.appendChild(popover);

  const input = popover.querySelector('.qa-popover-input');
  const btn = popover.querySelector('.qa-popover-btn');
  const loading = popover.querySelector('.qa-popover-loading');
  const result = popover.querySelector('.qa-popover-result');
  const errorDiv = popover.querySelector('.qa-popover-error');
  const selectedDiv = popover.querySelector('.qa-popover-selected');
  let selectedText = '';
  let isAsking = false;
  let highlightMark = null;

  popover.querySelector('.qa-popover-close').addEventListener('click', hidePopover);

  function highlightSelection(range) {
    // Wrap selected text in a highlight mark
    try {
      removeHighlight();
      highlightMark = document.createElement('mark');
      highlightMark.className = 'qa-highlight';
      range.surroundContents(highlightMark);
    } catch {
      // surroundContents fails if selection crosses element boundaries
      // Fall back to no highlight
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
    input.value = '';
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

    // Position below selection
    const top = rect.bottom + window.scrollY + 8;
    const left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 320));
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';
    popover.style.display = 'block';

    // Focus input without clearing selection (use requestAnimationFrame)
    requestAnimationFrame(() => input.focus());
  }

  function hidePopover() {
    popover.style.display = 'none';
    selectedText = '';
    selectedDiv.style.display = 'none';
    removeHighlight();
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  async function askQuestion() {
    if (isAsking) return;
    const question = input.value.trim();
    if (!question || !selectedText) return;

    isAsking = true;
    popover.querySelector('.qa-popover-body').style.display = 'none';
    loading.style.display = 'flex';
    errorDiv.style.display = 'none';

    try {
      const resp = await fetch('/api/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({
          selected_text: selectedText,
          question: question,
          page_slug: pageSlug,
          page_id: parseInt(pageId)
        })
      });

      const data = await resp.json();
      loading.style.display = 'none';

      if (data.ok) {
        result.innerHTML = `<a href="${data.url}" class="qa-result-link">💬 ${esc(data.title)}</a><span class="qa-result-hint">새 개념 페이지가 생성되었습니다</span>`;
        result.style.display = 'block';

        // Replace highlight with a link to the new page
        if (highlightMark && highlightMark.parentNode) {
          const link = document.createElement('a');
          link.href = data.url;
          link.textContent = highlightMark.textContent;
          link.className = 'wiki-link dynamic-link';
          link.title = '💬 ' + data.title;
          highlightMark.parentNode.replaceChild(link, highlightMark);
          highlightMark = null;
        }
      } else {
        errorDiv.textContent = data.error || '오류가 발생했습니다';
        errorDiv.style.display = 'block';
      }
    } catch (e) {
      loading.style.display = 'none';
      errorDiv.textContent = '서버 연결에 실패했습니다';
      errorDiv.style.display = 'block';
    } finally {
      isAsking = false;
    }
  }

  // Event: text selection
  document.addEventListener('mouseup', (e) => {
    // Don't trigger if clicking inside popover
    if (popover.contains(e.target)) return;

    const selection = window.getSelection();
    const text = selection?.toString().trim();

    if (!text || text.length < 3) {
      // Only hide if clicking outside popover and no active result
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

    showPopover(text, range.getBoundingClientRect(), range.cloneRange());
  });

  // Mobile: use selectionchange with debounce
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
    }, 500);
  });

  // Event: ask button
  btn.addEventListener('click', askQuestion);

  // Event: Enter key in input
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') askQuestion();
    if (e.key === 'Escape') hidePopover();
  });

  // Prevent popover clicks from dismissing
  popover.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
})();
