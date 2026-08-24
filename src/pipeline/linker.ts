import type { Store, Page } from "../store";
import { splitProtectedMarkdown, type MarkdownSegment } from "./markdown-segments";

// Auto-linking must never rewrite syntax that already has navigation or code
// semantics. Generated links are inserted as protected segments too, so later
// (shorter) title passes cannot match inside their label or destination.
const EXISTING_WIKI_LINK = /\[([^\]\r\n]+)\]\(\/wiki\/([^\s)?#]+?)(?:\.html)?(?:[?#][^)]*)?\)/gi;

function existingWikiLinks(content: string): Array<{ anchor: string; slug: string }> {
  const links: Array<{ anchor: string; slug: string }> = [];
  EXISTING_WIKI_LINK.lastIndex = 0;
  for (const match of content.matchAll(EXISTING_WIKI_LINK)) {
    try {
      links.push({ anchor: match[1], slug: decodeURIComponent(match[2]) });
    } catch {
      // A malformed existing link remains byte-for-byte unchanged and is not
      // inserted into the relational backlink index.
    }
  }
  return links;
}

export function autoLinkPages(store: Store): number {
  const pages = store.listPages();
  if (!pages.length) return 0;

  store.clearLinks();
  let totalLinks = 0;
  const pagesBySlug = new Map(pages.map((page) => [page.slug, page]));

  // Sort targets by title length descending (longest match first)
  const targets = [...pages].sort((a, b) => b.title.length - a.title.length);

  // Precompile patterns
  const patterns: Array<{ regex: RegExp; page: Page }> = [];
  for (const target of targets) {
    if (target.title.length < 3) continue;
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    patterns.push({
      regex: new RegExp(`(?<!\\[)(?<!\\w)(${escaped})(?!\\w)(?!\\])`, "i"),
      page: target,
    });
  }

  for (const page of pages) {
    const segments = splitProtectedMarkdown(page.content);
    const linkedSlugs = new Set<string>();

    // clearLinks() intentionally rebuilds the relationship table. Preserve
    // already-rendered Markdown links without modifying their source text.
    for (const link of existingWikiLinks(page.content)) {
      const target = pagesBySlug.get(link.slug);
      if (!target || target.id === page.id || linkedSlugs.has(target.slug)) continue;
      linkedSlugs.add(target.slug);
      store.addLink(page.id, target.id, link.anchor);
      totalLinks++;
    }

    let contentChanged = false;

    for (const { regex, page: target } of patterns) {
      if (target.id === page.id) continue;
      if (linkedSlugs.has(target.slug)) continue;

      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        if (segment.protected) continue;
        const match = regex.exec(segment.text);
        if (!match) continue;

        const matched = match[1];
        const replacement = `[${matched}](/wiki/${target.slug})`;
        const before = segment.text.slice(0, match.index);
        const after = segment.text.slice(match.index + match[0].length);
        const replacementSegments: MarkdownSegment[] = [];
        const matchStart = segment.start + match.index;
        const matchEnd = matchStart + match[0].length;
        if (before) replacementSegments.push({ text: before, protected: false, start: segment.start, end: matchStart });
        replacementSegments.push({ text: replacement, protected: true, start: matchStart, end: matchEnd });
        if (after) replacementSegments.push({ text: after, protected: false, start: matchEnd, end: segment.end });
        segments.splice(index, 1, ...replacementSegments);

        linkedSlugs.add(target.slug);
        store.addLink(page.id, target.id, matched);
        totalLinks++;
        contentChanged = true;
        break;
      }
    }

    if (contentChanged) {
      store.updatePageContent(page.id, segments.map((segment) => segment.text).join(""));
    }
  }

  return totalLinks;
}
