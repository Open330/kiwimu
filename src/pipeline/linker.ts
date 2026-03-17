import type { Store, Page } from "../store";

export function autoLinkPages(store: Store): number {
  const pages = store.listPages();
  if (!pages.length) return 0;

  store.clearLinks();
  let totalLinks = 0;

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
    let content = page.content;
    const linkedSlugs = new Set<string>();

    for (const { regex, page: target } of patterns) {
      if (target.id === page.id) continue;
      if (linkedSlugs.has(target.slug)) continue;

      const match = regex.exec(content);
      if (match) {
        const matched = match[1];
        const replacement = `[${matched}](/wiki/${target.slug})`;
        content = content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);
        linkedSlugs.add(target.slug);
        store.addLink(page.id, target.id, matched);
        totalLinks++;
      }
    }

    if (linkedSlugs.size > 0) {
      store.updatePageContent(page.id, content);
    }
  }

  return totalLinks;
}
