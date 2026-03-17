"""Auto-link wiki pages by detecting mentions of page titles."""

from __future__ import annotations

import re

from ..store.store import Page, Store


def auto_link_pages(store: Store) -> int:
    """Scan all pages and create inter-page links. Returns link count."""
    pages = store.list_pages()
    if not pages:
        return 0

    store.clear_links()
    total_links = 0

    # Build lookup: slug -> page
    page_map = {p.slug: p for p in pages}

    # Sort targets by title length descending (longest match first)
    targets = sorted(pages, key=lambda p: len(p.title), reverse=True)

    # Precompile patterns
    patterns: list[tuple[re.Pattern, Page]] = []
    for target in targets:
        title = target.title.strip()
        if len(title) < 3:
            continue
        # Word-boundary match, case insensitive
        # Skip if title is inside markdown link syntax
        pattern = re.compile(
            r"(?<!\[)"  # not preceded by [
            r"(?<!\w)"  # word boundary
            r"(" + re.escape(title) + r")"
            r"(?!\w)"   # word boundary
            r"(?!\])",  # not followed by ]
            re.IGNORECASE,
        )
        patterns.append((pattern, target))

    for page in pages:
        content = page.content
        linked_slugs: set[str] = set()
        new_content = content

        for pattern, target in patterns:
            if target.id == page.id:
                continue
            if target.slug in linked_slugs:
                continue

            match = pattern.search(new_content)
            if match:
                # Only link the first occurrence
                matched_text = match.group(1)
                replacement = f"[{matched_text}](/wiki/{target.slug})"
                new_content = (
                    new_content[: match.start()]
                    + replacement
                    + new_content[match.end() :]
                )
                linked_slugs.add(target.slug)
                store.add_link(page.id, target.id, matched_text)
                total_links += 1

        if new_content != content:
            store.update_page_content(page.id, new_content)

    return total_links
