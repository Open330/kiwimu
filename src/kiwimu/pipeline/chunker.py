"""Chunk raw content into wiki pages."""

from __future__ import annotations

import re
import unicodedata

from markdownify import markdownify as md

from ..ingest.web import Section
from ..store.store import Store


def slugify(text: str) -> str:
    """Convert text to a URL-safe slug."""
    text = unicodedata.normalize("NFKD", text)
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[-\s]+", "-", text)
    return text.strip("-")[:80]


# Words that are too generic to be useful page titles
STOP_TITLES = {
    "introduction", "overview", "summary", "conclusion", "references",
    "bibliography", "appendix", "abstract", "preface", "contents",
    "table of contents", "index", "acknowledgments", "notes",
}


def clean_title(title: str) -> str:
    """Remove section numbering and clean up whitespace from titles."""
    # Remove leading section numbers like "1.1.1", "1.2", "Chapter 1", etc.
    title = re.sub(r"^\s*(Chapter\s+)?\d+(\.\d+)*\s*", "", title, flags=re.IGNORECASE)
    # Collapse whitespace / newlines
    title = re.sub(r"\s+", " ", title).strip()
    return title


def chunk_sections(
    sections: list[Section],
    source_id: int,
    store: Store,
    min_words: int = 30,
) -> int:
    """Convert sections into wiki pages. Returns count of pages created."""
    count = 0
    for section in sections:
        title = clean_title(section.title)
        if not title:
            continue

        slug = slugify(title)
        if not slug:
            continue

        # Convert HTML parts to markdown
        html_content = "\n".join(section.html_parts)
        if not html_content.strip():
            continue

        content = md(html_content, heading_style="ATX", strip=["script", "style"])
        content = content.strip()

        # Skip very short sections
        word_count = len(content.split())
        if word_count < min_words:
            continue

        # Skip generic titles but keep their content if substantial
        if slug in STOP_TITLES or title.lower() in STOP_TITLES:
            if word_count < 100:
                continue

        # Check for duplicate slugs and make unique
        existing = store.get_page(slug)
        if existing:
            # Append content to existing page
            new_content = existing.content + "\n\n" + content
            store.update_page_content(existing.id, new_content)
        else:
            store.add_page(
                slug=slug,
                title=title,
                content=content,
                source_id=source_id,
                section_anchor=slug,
            )
            count += 1

    return count
