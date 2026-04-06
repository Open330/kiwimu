import type { Store, Citation } from "../store";

/**
 * Parse [^src:SLUG] citation markers in page body.
 * Creates citation DB records and replaces markers with numbered footnote references.
 */
export function parseCitations(body: string, pageId: number, store: Store): string {
  const page = store.getPageById(pageId);
  if (!page) return body;

  // Find all [^src:SLUG] markers
  const markerRegex = /\[\^src:([^\]]+)\]/g;
  const markers: Array<{ fullMatch: string; slug: string; index: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = markerRegex.exec(body)) !== null) {
    markers.push({ fullMatch: match[0], slug: match[1], index: match.index });
  }

  if (markers.length === 0) return body;

  // Delete existing citations for this page to avoid duplicates on re-parse
  store.deleteCitationsForPage(pageId);

  // Build footnote references
  let result = body;
  let footnoteNum = 0;
  const citationMap = new Map<string, number>(); // slug -> footnote number

  // Process in reverse order to preserve indices during replacement
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i];
    const sourcePage = store.getPage(marker.slug);

    if (!sourcePage || !sourcePage.source_id) {
      // Remove invalid markers silently
      result = result.slice(0, marker.index) + result.slice(marker.index + marker.fullMatch.length);
      continue;
    }

    // Assign footnote number (reuse if same slug cited multiple times)
    if (!citationMap.has(marker.slug)) {
      footnoteNum = citationMap.size + 1;
      citationMap.set(marker.slug, footnoteNum);
    }
    const num = citationMap.get(marker.slug)!;

    // Extract context: ~80 chars surrounding the marker
    const contextStart = Math.max(0, marker.index - 80);
    const contextEnd = Math.min(body.length, marker.index + marker.fullMatch.length + 80);
    const context = body.slice(contextStart, contextEnd).replace(/\[\^src:[^\]]+\]/g, '').trim();

    // Create citation record
    store.addCitation(pageId, sourcePage.source_id, sourcePage.id, null, context);

    // Replace marker with footnote superscript
    const footnoteRef = `<sup class="citation-ref"><a href="#cite-${num}" title="${escapeCitationTitle(sourcePage.title)}">[${num}]</a></sup>`;
    result = result.slice(0, marker.index) + footnoteRef + result.slice(marker.index + marker.fullMatch.length);
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
      const link = slug ? `<a href="/wiki/${slug}.html">${escapeHtml(title)}</a>` : escapeHtml(title);
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
