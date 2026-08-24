    const icons = { ingest: "📥", page_created: "📄", page_updated: "✏️", quiz_generated: "🧩", quiz_attempted: "📝", query: "❓", build: "🔨", deploy: "🚀", expand: "🧠" };
    const labels = { ingest: "수집", page_created: "문서 생성", page_updated: "문서 수정", quiz_generated: "퀴즈 생성", quiz_attempted: "퀴즈 풀이", query: "질문", build: "사이트 빌드", deploy: "배포", expand: "콘텐츠 확장" };
    let currentAction = '';
    let offset = 0;
    const limit = 50;
    let loadGeneration = 0;
    let loadController = null;
    let retryOffset = null;

    function formatTime(iso) {
      const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');
      if (Number.isNaN(d.getTime())) return '';
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return '방금 전';
      if (diff < 3600000) return Math.floor(diff/60000) + '분 전';
      if (diff < 86400000) return Math.floor(diff/3600000) + '시간 전';
      return d.toLocaleDateString('ko-KR') + ' ' + d.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'});
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
      const generation = ++loadGeneration;
      if (loadController) loadController.abort();
      const controller = new AbortController();
      loadController = controller;
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (currentAction) params.set('action', currentAction);
      const tl = document.getElementById('timeline');
      const status = document.getElementById('activity-status');
      const loadMore = document.getElementById('load-more');
      tl.setAttribute('aria-busy', 'true');
      loadMore.disabled = true;
      status.textContent = '활동을 불러오는 중…';
      try {
        const res = await fetch('/kiwimu/api/activity?' + params, { credentials: 'same-origin', signal: controller.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (generation !== loadGeneration) return;
        const entries = Array.isArray(data.entries) ? data.entries : [];
        if (!append) tl.innerHTML = '';
        if (entries.length === 0 && offset === 0) {
          document.getElementById('empty').hidden = false;
          loadMore.hidden = true;
          status.textContent = '';
        } else {
          document.getElementById('empty').hidden = true;
          loadMore.hidden = entries.length < limit;
          tl.insertAdjacentHTML('beforeend', entries.map(renderEntry).join(''));
          status.textContent = entries.length + '개 활동을 불러왔습니다.';
        }
      } catch (error) {
        if (generation !== loadGeneration || error?.name === 'AbortError') return;
        if (!append) tl.innerHTML = '';
        retryOffset = offset;
        if (append) offset = Math.max(0, offset - limit);
        document.getElementById('empty').hidden = true;
        loadMore.hidden = false;
        status.textContent = append
          ? '추가 활동을 불러오지 못했습니다. 더 보기를 눌러 다시 시도해 주세요.'
          : '활동을 불러오지 못했습니다. 더 보기를 눌러 다시 시도해 주세요.';
      } finally {
        if (generation !== loadGeneration) return;
        if (loadController === controller) loadController = null;
        tl.setAttribute('aria-busy', 'false');
        loadMore.disabled = false;
      }
    }

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        currentAction = btn.dataset.action;
        offset = 0;
        retryOffset = null;
        loadEntries(false);
      });
    });

    document.getElementById('load-more').addEventListener('click', () => {
      const retrying = retryOffset !== null;
      if (retrying) offset = retryOffset;
      else offset += limit;
      retryOffset = null;
      loadEntries(retrying ? offset > 0 : true);
    });

    loadEntries(false);
