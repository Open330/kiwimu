"""Base interface for content expansion."""

from __future__ import annotations

from typing import Protocol

from ..store.store import Page


class Expander(Protocol):
    def expand_page(self, page: Page, context: list[Page]) -> str:
        """Expand a page's content. Returns new markdown content."""
        ...
