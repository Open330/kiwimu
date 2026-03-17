"""PDF ingestion - extract text and structure from PDF files."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .web import Section


def extract_from_pdf(pdf_path: Path) -> tuple[str, list[Section]]:
    """Extract sections from a PDF file using PyMuPDF."""
    import fitz  # pymupdf

    doc = fitz.open(str(pdf_path))
    title = doc.metadata.get("title", "") or pdf_path.stem

    sections: list[Section] = []
    current = Section(level=1, title="Introduction")

    for page in doc:
        blocks = page.get_text("dict")["blocks"]
        for block in blocks:
            if block["type"] != 0:  # text block
                continue
            for line in block.get("lines", []):
                text = "".join(span["text"] for span in line["spans"]).strip()
                if not text:
                    continue
                # Heuristic: large font or bold = heading
                max_size = max(span["size"] for span in line["spans"])
                is_bold = any("bold" in span["font"].lower() for span in line["spans"])

                if max_size > 14 or (max_size > 12 and is_bold):
                    if current.html_parts:
                        sections.append(current)
                    level = 1 if max_size > 16 else 2 if max_size > 14 else 3
                    current = Section(level=level, title=text)
                else:
                    current.html_parts.append(f"<p>{text}</p>")

    if current.html_parts:
        sections.append(current)

    doc.close()
    return title, sections
