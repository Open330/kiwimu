// Client-side fuzzy search
document.addEventListener("DOMContentLoaded", async () => {
    const input = document.getElementById("search-input");
    const dropdown = document.getElementById("search-results");
    if (!input || !dropdown) return;

    let searchData = [];
    try {
        const resp = await fetch("/search-index.json");
        searchData = await resp.json();
    } catch (e) {
        return;
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
        const results = search(input.value);
        if (results.length === 0) {
            dropdown.classList.remove("active");
            dropdown.innerHTML = "";
            return;
        }
        dropdown.innerHTML = results.map(r =>
            `<a href="/wiki/${r.slug}.html">
                <strong>${r.title}</strong>
                <div style="font-size:12px;color:#6c757d;margin-top:2px;">${r.preview.slice(0, 80)}...</div>
            </a>`
        ).join("");
        dropdown.classList.add("active");
    });

    input.addEventListener("blur", () => {
        setTimeout(() => dropdown.classList.remove("active"), 200);
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
        }
    });
});
