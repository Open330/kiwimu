// Client-side fuzzy search
document.addEventListener("DOMContentLoaded", async () => {
    const input = document.getElementById("search-input");
    const dropdown = document.getElementById("search-results");
    if (!input || !dropdown) return;

    let searchData = [];
    let selectedIndex = -1;
    let debounceTimer;

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-autocomplete', 'list');
    try {
        const resp = await fetch("/search-index.json");
        searchData = await resp.json();
    } catch (e) {
        return;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function fuzzyMatch(query, text) {
        query = query.toLowerCase();
        text = text.toLowerCase();
        if (text.includes(query)) return true;
        let qi = 0;
        for (let i = 0; i < text.length && qi < query.length; i++) {
            if (text[i] === query[qi]) qi++;
        }
        return qi === query.length;
    }

    function search(query) {
        if (!query.trim()) return [];
        return searchData
            .filter(item => fuzzyMatch(query, item.title) || fuzzyMatch(query, item.preview))
            .slice(0, 8);
    }

    input.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            selectedIndex = -1;
            const results = search(input.value);
            if (results.length === 0) {
                dropdown.classList.remove("active");
                dropdown.innerHTML = "";
                input.setAttribute('aria-expanded', 'false');
                return;
            }
            dropdown.setAttribute('role', 'listbox');
            dropdown.innerHTML = results.map(r =>
                `<a href="/wiki/${r.slug}.html" role="option">
                    <strong>${escapeHtml(r.title)}</strong>
                    <div style="font-size:12px;color:#6c757d;margin-top:2px;">${escapeHtml(r.preview.slice(0, 80))}...</div>
                </a>`
            ).join("");
            dropdown.classList.add("active");
            input.setAttribute('aria-expanded', 'true');
        }, 150);
    });

    input.addEventListener("blur", () => {
        setTimeout(() => {
            dropdown.classList.remove("active");
            input.setAttribute('aria-expanded', 'false');
        }, 200);
    });

    input.addEventListener("focus", () => {
        if (input.value.trim() && dropdown.innerHTML) {
            dropdown.classList.add("active");
        }
    });

    // Keyboard navigation
    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            dropdown.classList.remove("active");
            input.blur();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            const items = dropdown.querySelectorAll("a");
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            items.forEach((a, i) => a.classList.toggle("selected", i === selectedIndex));
            items[selectedIndex]?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const items = dropdown.querySelectorAll("a");
            selectedIndex = Math.max(selectedIndex - 1, 0);
            items.forEach((a, i) => a.classList.toggle("selected", i === selectedIndex));
        } else if (e.key === "Enter" && selectedIndex >= 0) {
            e.preventDefault();
            dropdown.querySelectorAll("a")[selectedIndex]?.click();
        }
    });

    // Global "/" shortcut to focus search
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === '/') {
            e.preventDefault();
            input.focus();
        }
    });
});
