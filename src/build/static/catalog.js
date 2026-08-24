(function() {
  const input = document.getElementById('catalog-search');
  const status = document.getElementById('catalog-filter-status');
  const noResults = document.getElementById('catalog-no-results');
  if (!input) return;
  input.addEventListener('input', function() {
    const q = this.value.toLowerCase().trim();
    let totalVisible = 0;
    document.querySelectorAll('.catalog-item').forEach(function(item) {
      const title = item.getAttribute('data-title') || '';
      const visible = !q || title.includes(q);
      item.hidden = !visible;
      if (visible) totalVisible++;
    });
    // Hide empty categories
    document.querySelectorAll('.catalog-category').forEach(function(cat) {
      const allItems = cat.querySelectorAll('.catalog-item');
      let visibleCount = 0;
      allItems.forEach(function(item) { if (!item.hidden) visibleCount++; });
      cat.hidden = Boolean(q && visibleCount === 0);
    });
    status.textContent = q ? totalVisible + '개 문서 검색됨' : status.dataset.defaultText || '';
    noResults.hidden = !q || totalVisible > 0;
  });
})();
