"""Web page ingestion - fetch and extract structured content."""

from __future__ import annotations

from dataclasses import dataclass, field

import requests
from bs4 import BeautifulSoup, NavigableString, Tag


@dataclass
class Section:
    level: int
    title: str
    html_parts: list[str] = field(default_factory=list)


# Tags that are headings
HEADING_TAGS = {"h1", "h2", "h3", "h4"}

# Tags to skip entirely (navigation, footer, etc.)
SKIP_TAGS = {"nav", "header", "footer", "script", "style", "noscript"}

# Tags whose children should be traversed individually
# (i.e., structural containers that don't carry content themselves)
CONTAINER_TAGS = {
    "html", "head", "body", "div", "article", "main", "section",
    "aside", "details", "summary",
}


def fetch_page(url: str) -> tuple[str, str]:
    """Fetch a URL and return (title, html_body)."""
    resp = requests.get(url, timeout=30, headers={
        "User-Agent": "kiwimu/0.1 (learning wiki builder)"
    })
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else url
    body = soup.find("body")
    return title, str(body) if body else resp.text


def extract_sections(html: str) -> list[Section]:
    """Walk the DOM tree and split content at heading boundaries."""
    soup = BeautifulSoup(html, "html.parser")
    sections: list[Section] = []
    current = Section(level=1, title="Introduction")

    def walk(node):
        nonlocal current

        if isinstance(node, NavigableString):
            # Bare text nodes (outside any tag) - usually whitespace
            return

        if not isinstance(node, Tag):
            return

        # Skip non-content elements
        if node.name in SKIP_TAGS:
            return

        # Heading -> start a new section
        if node.name in HEADING_TAGS:
            if current.html_parts:
                sections.append(current)
            current = Section(
                level=int(node.name[1]),
                title=node.get_text(strip=True),
            )
            return

        # Container -> recurse into children
        if node.name in CONTAINER_TAGS:
            for child in node.children:
                walk(child)
            return

        # Content element (p, figure, table, ul, ol, pre, blockquote, etc.)
        html_str = str(node)
        if html_str.strip():
            current.html_parts.append(html_str)

    # BeautifulSoup document node has name '[document]' - iterate its children
    for child in soup.children:
        walk(child)

    if current.html_parts:
        sections.append(current)

    # Filter out empty sections
    return [s for s in sections if s.html_parts]
