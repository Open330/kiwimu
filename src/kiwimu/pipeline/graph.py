"""Build knowledge graph data for visualization."""

from __future__ import annotations

import json
from pathlib import Path

from ..store.store import Store


def build_graph_data(store: Store) -> dict:
    """Generate D3.js-compatible graph data from the links table."""
    pages = store.list_pages()
    links = store.get_all_links()

    # Calculate degree for node sizing
    degree: dict[int, int] = {}
    for page in pages:
        degree[page.id] = 0
    for link in links:
        degree[link.from_page_id] = degree.get(link.from_page_id, 0) + 1
        degree[link.to_page_id] = degree.get(link.to_page_id, 0) + 1

    nodes = [
        {
            "id": page.slug,
            "title": page.title,
            "degree": degree.get(page.id, 0),
        }
        for page in pages
    ]

    link_data = []
    slug_map = {p.id: p.slug for p in pages}
    for link in links:
        if link.from_page_id in slug_map and link.to_page_id in slug_map:
            link_data.append({
                "source": slug_map[link.from_page_id],
                "target": slug_map[link.to_page_id],
            })

    return {"nodes": nodes, "links": link_data}


def export_graph_json(store: Store, output_path: Path) -> None:
    """Write graph data to a JSON file."""
    data = build_graph_data(store)
    output_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
