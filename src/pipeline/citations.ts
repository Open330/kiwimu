import type { Store, Citation, CitationInput } from "../store";
import { escapeHtml } from "../utils";
import { splitProtectedMarkdown } from "./markdown-segments";

/**
 * Parse [^src:SLUG] citation markers in page body.
 * Creates citation DB records and replaces markers with numbered footnote references.
 */
export function parseCitations(body: string, pageId: number, store: Store): string {
  const page = store.getPageById(pageId);
  if (!page) return body;

  // Keep this grammar aligned with generated slugs: Unicode letters/numbers,
  // underscore, and internal hyphens. Citation examples inside code or links
  // are documentation, not provenance records.
  const markerRegex = /\[\^src:([-_\p{L}\p{N}\p{M}]+)\]/giu;
  const markers: Array<{ fullMatch: string; slug: string; index: number }> = [];
  for (const segment of splitProtectedMarkdown(body)) {
    if (segment.protected) continue;
    markerRegex.lastIndex = 0;
    for (const match of segment.text.matchAll(markerRegex)) {
      markers.push({
        fullMatch: match[0],
        slug: match[1],
        index: segment.start + match.index,
      });
    }
  }

  if (markers.length === 0) {
    store.replaceCitations(pageId, []);
    return body;
  }

  // Resolve and render first, then publish the complete persistence set in one
  // atomic operation. No partially rebuilt citation list is externally visible.
  const replacements: Array<{ marker: (typeof markers)[number]; html: string }> = [];
  const citations: CitationInput[] = [];
  const citationMap = new Map<string, number>(); // slug -> footnote number

  for (const marker of markers) {
    const sourcePage = store.getPage(marker.slug);

    if (!sourcePage || !sourcePage.source_id) {
      // Preserve the visible marker. Silently removing a hallucinated or stale
      // source slug would make an unsupported claim look properly authored.
      continue;
    }

    // Assign footnote number (reuse if same slug cited multiple times)
    if (!citationMap.has(marker.slug)) {
      citationMap.set(marker.slug, citationMap.size + 1);
    }
    const num = citationMap.get(marker.slug)!;

    // Extract context: ~80 chars surrounding the marker
    const contextStart = Math.max(0, marker.index - 80);
    const contextEnd = Math.min(body.length, marker.index + marker.fullMatch.length + 80);
    const context = body.slice(contextStart, contextEnd).replace(/\[\^src:[^\]]+\]/g, '').trim();

    citations.push({ sourceId: sourcePage.source_id, sourcePageId: sourcePage.id, context });

    const footnoteRef = `<sup class="citation-ref"><a href="#cite-${num}" title="${escapeCitationTitle(sourcePage.title)}">[${num}]</a></sup>`;
    replacements.push({ marker, html: footnoteRef });
  }

  store.replaceCitations(pageId, citations);

  // Apply replacements in reverse so original marker indices remain valid.
  let result = body;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { marker, html } = replacements[i];
    result = result.slice(0, marker.index) + html + result.slice(marker.index + marker.fullMatch.length);
  }

  return result;
}

function escapeCitationTitle(title: string): string {
  return title.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render a "Sources" footer section from citation records.
 */
export function renderCitationFootnotes(citations: Citation[]): string {
  if (!citations.length) return "";

  // Deduplicate by source_page_id (or source_id if no page)
  const seen = new Map<string, { num: number; citation: Citation }>();
  let num = 0;

  for (const c of citations) {
    const key = c.source_page_id ? `page:${c.source_page_id}` : `source:${c.source_id}`;
    if (!seen.has(key)) {
      num++;
      seen.set(key, { num, citation: c });
    }
  }

  const items = Array.from(seen.values())
    .map(({ num, citation }) => {
      const title = citation.source_page_title || citation.source_title || `Source #${citation.source_id}`;
      const slug = citation.source_page_slug;
      const link = slug ? `<a href="/wiki/${encodeURIComponent(slug)}.html">${escapeHtml(title)}</a>` : escapeHtml(title);
      const excerpt = citation.excerpt
        ? `<span class="citation-excerpt">"${escapeHtml(citation.excerpt.slice(0, 200))}"</span>`
        : "";
      return `<li id="cite-${num}" class="citation-item"><span class="citation-num">[${num}]</span> ${link}${excerpt ? " — " + excerpt : ""}</li>`;
    })
    .join("\n");

  return `<aside class="citations-section">
<h3>Sources</h3>
<ol class="citation-list">
${items}
</ol>
</aside>`;
}

// escapeHtml imported from ../utils
