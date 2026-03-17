"""SQLite-backed storage for pages, links, and sources."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uri TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    title TEXT,
    raw_content TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id),
    section_anchor TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS links (
    from_page_id INTEGER REFERENCES pages(id),
    to_page_id INTEGER REFERENCES pages(id),
    anchor_text TEXT,
    PRIMARY KEY (from_page_id, to_page_id, anchor_text)
);
"""


@dataclass
class Source:
    id: int
    uri: str
    type: str
    title: str
    raw_content: str
    fetched_at: str


@dataclass
class Page:
    id: int
    slug: str
    title: str
    content: str
    source_id: Optional[int] = None
    section_anchor: Optional[str] = None


@dataclass
class Link:
    from_page_id: int
    to_page_id: int
    anchor_text: str


class Store:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")

    def init_schema(self) -> None:
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # --- Sources ---

    def add_source(self, uri: str, type: str, title: str, raw_content: str) -> Source:
        cur = self.conn.execute(
            "INSERT OR REPLACE INTO sources (uri, type, title, raw_content) VALUES (?, ?, ?, ?)",
            (uri, type, title, raw_content),
        )
        self.conn.commit()
        row = self.conn.execute("SELECT * FROM sources WHERE id = ?", (cur.lastrowid,)).fetchone()
        return Source(**dict(row))

    def get_source(self, uri: str) -> Optional[Source]:
        row = self.conn.execute("SELECT * FROM sources WHERE uri = ?", (uri,)).fetchone()
        return Source(**dict(row)) if row else None

    def list_sources(self) -> list[Source]:
        rows = self.conn.execute("SELECT * FROM sources ORDER BY fetched_at DESC").fetchall()
        return [Source(**dict(r)) for r in rows]

    # --- Pages ---

    def add_page(self, slug: str, title: str, content: str, source_id: int | None = None, section_anchor: str | None = None) -> Page:
        cur = self.conn.execute(
            """INSERT OR REPLACE INTO pages (slug, title, content, source_id, section_anchor)
               VALUES (?, ?, ?, ?, ?)""",
            (slug, title, content, source_id, section_anchor),
        )
        self.conn.commit()
        row = self.conn.execute("SELECT * FROM pages WHERE id = ?", (cur.lastrowid,)).fetchone()
        return Page(id=row["id"], slug=row["slug"], title=row["title"], content=row["content"],
                    source_id=row["source_id"], section_anchor=row["section_anchor"])

    def get_page(self, slug: str) -> Optional[Page]:
        row = self.conn.execute("SELECT * FROM pages WHERE slug = ?", (slug,)).fetchone()
        if not row:
            return None
        return Page(id=row["id"], slug=row["slug"], title=row["title"], content=row["content"],
                    source_id=row["source_id"], section_anchor=row["section_anchor"])

    def list_pages(self) -> list[Page]:
        rows = self.conn.execute("SELECT * FROM pages ORDER BY title").fetchall()
        return [Page(id=r["id"], slug=r["slug"], title=r["title"], content=r["content"],
                     source_id=r["source_id"], section_anchor=r["section_anchor"]) for r in rows]

    def update_page_content(self, page_id: int, content: str) -> None:
        self.conn.execute(
            "UPDATE pages SET content = ?, updated_at = datetime('now') WHERE id = ?",
            (content, page_id),
        )
        self.conn.commit()

    # --- Links ---

    def add_link(self, from_id: int, to_id: int, anchor_text: str) -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO links (from_page_id, to_page_id, anchor_text) VALUES (?, ?, ?)",
            (from_id, to_id, anchor_text),
        )
        self.conn.commit()

    def clear_links(self) -> None:
        self.conn.execute("DELETE FROM links")
        self.conn.commit()

    def get_links_from(self, page_id: int) -> list[Link]:
        rows = self.conn.execute(
            "SELECT * FROM links WHERE from_page_id = ?", (page_id,)
        ).fetchall()
        return [Link(**dict(r)) for r in rows]

    def get_backlinks(self, page_id: int) -> list[Page]:
        rows = self.conn.execute(
            """SELECT p.* FROM pages p
               JOIN links l ON l.from_page_id = p.id
               WHERE l.to_page_id = ?
               ORDER BY p.title""",
            (page_id,),
        ).fetchall()
        return [Page(id=r["id"], slug=r["slug"], title=r["title"], content=r["content"],
                     source_id=r["source_id"], section_anchor=r["section_anchor"]) for r in rows]

    def get_all_links(self) -> list[Link]:
        rows = self.conn.execute("SELECT * FROM links").fetchall()
        return [Link(**dict(r)) for r in rows]
