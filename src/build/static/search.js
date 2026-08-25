// Accessible client-side fuzzy search. The potentially large search index is
// fetched only when a user first interacts with search.
document.addEventListener("DOMContentLoaded", () => {
    const input = document.getElementById("search-input");
    const dropdown = document.getElementById("search-results");
    const status = document.getElementById("search-status");
    if (!input || !dropdown) return;

    let searchData = [];
    let loadPromise = null;
    let selectedIndex = -1;
    let debounceTimer;
    let renderGeneration = 0;

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", dropdown.id);
    input.setAttribute("aria-haspopup", "listbox");
    input.setAttribute("aria-autocomplete", "list");
    dropdown.setAttribute("role", "listbox");

    function announce(message) {
        if (status) status.textContent = message;
    }

    function setOpen(open) {
        dropdown.classList.toggle("active", open);
        input.setAttribute("aria-expanded", String(open));
        if (!open) {
            selectedIndex = -1;
            input.removeAttribute("aria-activedescendant");
        }
    }

    async function ensureData() {
        if (loadPromise) return loadPromise;
        input.setAttribute("aria-busy", "true");
        announce("검색 색인을 불러오는 중…");
        loadPromise = fetch("/search-index.json", { credentials: "same-origin" })
            .then((resp) => {
                if (!resp.ok) throw new Error("search index " + resp.status);
                return resp.json();
            })
            .then((data) => {
                searchData = Array.isArray(data)
                    ? data.filter((item) => item && typeof item.title === "string" && typeof item.slug === "string")
                    : [];
                announce("");
                return searchData;
            })
            .catch(() => {
                searchData = [];
                loadPromise = null; // allow a later interaction to retry
                announce("검색 색인을 불러오지 못했습니다.");
                return searchData;
            })
            .finally(() => input.removeAttribute("aria-busy"));
        return loadPromise;
    }

    function escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text == null ? "" : String(text);
        return div.innerHTML;
    }

    // Treat the user's query as a literal string when building a RegExp.
    function escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function isSubsequence(query, text) {
        let qi = 0;
        for (let i = 0; i < text.length && qi < query.length; i++) {
            if (text[i] === query[qi]) qi++;
        }
        return qi === query.length;
    }

    // Relevance tiers: title prefix (4) > title substring (3) > preview
    // substring (2) > subsequence in either field (1). 0 means no match.
    function scoreItem(query, item) {
        const title = String(item.title || "").toLocaleLowerCase();
        const preview = String(item.preview || "").toLocaleLowerCase();
        if (title.startsWith(query)) return 4;
        if (title.includes(query)) return 3;
        if (preview.includes(query)) return 2;
        if (isSubsequence(query, title) || isSubsequence(query, preview)) return 1;
        return 0;
    }

    function search(query) {
        const trimmed = query.trim();
        if (!trimmed) return [];
        const normalized = trimmed.toLocaleLowerCase();
        const scored = [];
        for (let i = 0; i < searchData.length; i++) {
            const score = scoreItem(normalized, searchData[i]);
            if (score > 0) scored.push({ item: searchData[i], score, index: i });
        }
        // Highest score first; preserve original order within the same score.
        scored.sort((a, b) => b.score - a.score || a.index - b.index);
        return scored.slice(0, 8).map((entry) => entry.item);
    }

    // XSS-safe: every slice of the source text is escaped before it becomes
    // markup; only the literal <mark> wrapper is inserted as HTML.
    function highlight(text, query) {
        const raw = text == null ? "" : String(text);
        const trimmed = query.trim();
        if (!trimmed) return escapeHtml(raw);
        const matcher = new RegExp(escapeRegExp(trimmed), "gi");
        let result = "";
        let lastIndex = 0;
        let match;
        while ((match = matcher.exec(raw)) !== null) {
            result += escapeHtml(raw.slice(lastIndex, match.index));
            result += `<mark class="search-highlight">${escapeHtml(match[0])}</mark>`;
            lastIndex = match.index + match[0].length;
            if (match.index === matcher.lastIndex) matcher.lastIndex++; // guard against zero-length matches
        }
        result += escapeHtml(raw.slice(lastIndex));
        return result;
    }

    function selectResult(index) {
        const items = Array.from(dropdown.querySelectorAll('[role="option"]'));
        if (!items.length) return;
        selectedIndex = Math.max(0, Math.min(index, items.length - 1));
        items.forEach((item, itemIndex) => {
            const selected = itemIndex === selectedIndex;
            item.classList.toggle("selected", selected);
            item.setAttribute("aria-selected", String(selected));
        });
        const active = items[selectedIndex];
        input.setAttribute("aria-activedescendant", active.id);
        active.scrollIntoView({ block: "nearest" });
    }

    function renderResults() {
        selectedIndex = -1;
        input.removeAttribute("aria-activedescendant");
        const query = input.value.trim();
        const results = search(input.value);
        if (!query || results.length === 0) {
            dropdown.replaceChildren();
            setOpen(false);
            announce(query ? "검색 결과가 없습니다." : "");
            return;
        }

        dropdown.innerHTML = results.map((result, index) => {
            const hasPreview = typeof result.preview === "string";
            const preview = hasPreview ? result.preview.slice(0, 80) : "";
            const previewSuffix = hasPreview && result.preview.length > 80 ? "…" : "";
            return `<a id="search-result-${index}" href="/wiki/${encodeURIComponent(result.slug)}.html" role="option" aria-selected="false">
                <strong>${highlight(result.title, query)}</strong>
                ${preview ? `<span class="search-preview">${highlight(preview, query)}${previewSuffix}</span>` : ""}
            </a>`;
        }).join("");
        setOpen(true);
        announce(results.length + "개 검색 결과");
    }

    input.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        const generation = ++renderGeneration;
        debounceTimer = setTimeout(async () => {
            await ensureData();
            if (generation === renderGeneration && document.activeElement === input) renderResults();
        }, 150);
    });

    input.addEventListener("blur", () => {
        clearTimeout(debounceTimer);
        renderGeneration++;
        setTimeout(() => setOpen(false), 150);
    });

    input.addEventListener("focus", async () => {
        const valueAtFocus = input.value;
        const generation = renderGeneration;
        await ensureData();
        if (
            valueAtFocus.trim()
            && input.value === valueAtFocus
            && generation === renderGeneration
            && document.activeElement === input
        ) renderResults();
    });

    input.addEventListener("keydown", (event) => {
        const items = dropdown.querySelectorAll('[role="option"]');
        if (event.key === "Escape") {
            setOpen(false);
        } else if (event.key === "ArrowDown" && items.length) {
            event.preventDefault();
            selectResult(selectedIndex + 1);
        } else if (event.key === "ArrowUp" && items.length) {
            event.preventDefault();
            selectResult(selectedIndex <= 0 ? items.length - 1 : selectedIndex - 1);
        } else if (event.key === "Home" && items.length) {
            event.preventDefault();
            selectResult(0);
        } else if (event.key === "End" && items.length) {
            event.preventDefault();
            selectResult(items.length - 1);
        } else if (event.key === "Enter" && selectedIndex >= 0) {
            event.preventDefault();
            items[selectedIndex]?.click();
        }
    });

    // Global shortcuts to focus search. Ignore editable controls so typing is
    // never hijacked. "/" quick-focuses; ⌘K / Ctrl-K acts as a command palette.
    document.addEventListener("keydown", (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            input.focus();
            return;
        }
        if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "k" || event.key === "K")) {
            event.preventDefault();
            input.focus();
            input.select();
        }
    });
});
