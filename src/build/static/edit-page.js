(function() {
  'use strict';
  const token = document.querySelector('meta[name="kiwi-auth"]')?.content;
  if (!token) return; // Static build - editing disabled

  const slug = document.querySelector('[data-page-slug]')?.dataset.pageSlug;
  if (!slug) return;

  const editBtn = document.querySelector('.edit-btn');
  const modal = document.getElementById('edit-modal');
  const textarea = document.getElementById('edit-textarea');
  if (!editBtn || !modal || !textarea) return;

  // Show the edit button only when auth token is present
  editBtn.style.display = 'inline';

  // Fetch current markdown content
  editBtn.addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/page/' + encodeURIComponent(slug), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const data = await resp.json();
      textarea.value = data.content;
      modal.style.display = 'flex';
    } catch (e) {
      alert('페이지 내용을 불러올 수 없습니다');
    }
  });

  // Close modal
  modal.querySelector('.edit-modal-close')?.addEventListener('click', () => {
    modal.style.display = 'none';
  });
  modal.querySelector('.edit-cancel')?.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  // Save
  modal.querySelector('.edit-save')?.addEventListener('click', async () => {
    const content = textarea.value;
    try {
      const resp = await fetch('/api/page/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ slug: slug, content: content })
      });
      const data = await resp.json();
      if (data.ok) {
        location.reload(); // Reload to see updated page
      } else {
        alert(data.error || '저장에 실패했습니다');
      }
    } catch (e) {
      alert('서버 연결에 실패했습니다');
    }
  });
})();
