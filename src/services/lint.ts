import type { Store } from "../store";

export interface LintIssue {
  type: 'orphan' | 'dead_link' | 'disconnected' | 'missing_backlink' | 'thin_content' | 'duplicate';
  severity: 'error' | 'warning' | 'info';
  pageId?: number;
  pageTitle?: string;
  message: string;
  suggestion?: string;
}

export interface LintReport {
  issues: LintIssue[];
  summary: { errors: number; warnings: number; info: number; total_pages: number; total_links: number };
  timestamp: string;
}

export async function lintWiki(store: Store): Promise<LintReport> {
  const pages = store.listPages();
  const links = store.getAllLinks();

  const pageMap = new Map(pages.map(p => [p.id, p]));
  const issues: LintIssue[] = [];

  // --- a) Orphan Pages: no incoming links ---
  const incomingCount = new Map<number, number>();
  for (const link of links) {
    incomingCount.set(link.to_page_id, (incomingCount.get(link.to_page_id) || 0) + 1);
  }
  for (const page of pages) {
    if (!incomingCount.has(page.id)) {
      issues.push({
        type: 'orphan',
        severity: 'warning',
        pageId: page.id,
        pageTitle: page.title,
        message: `"${page.title}" has no incoming links (orphan page)`,
        suggestion: 'Add links to this page from related pages',
      });
    }
  }

  // --- b) Dead Links: links pointing to non-existent pages ---
  for (const link of links) {
    if (!pageMap.has(link.to_page_id)) {
      const fromPage = pageMap.get(link.from_page_id);
      issues.push({
        type: 'dead_link',
        severity: 'error',
        pageId: link.from_page_id,
        pageTitle: fromPage?.title,
        message: `Dead link from "${fromPage?.title || link.from_page_id}" to non-existent page (id: ${link.to_page_id}, anchor: "${link.anchor_text}")`,
        suggestion: 'Remove or fix the broken link',
      });
    }
    if (!pageMap.has(link.from_page_id)) {
      issues.push({
        type: 'dead_link',
        severity: 'error',
        pageId: link.from_page_id,
        message: `Dead link from non-existent page (id: ${link.from_page_id}) to page id ${link.to_page_id}`,
        suggestion: 'Clean up orphaned link records',
      });
    }
  }

  // --- c) Disconnected Clusters ---
  // Build adjacency list (undirected) for connectivity
  const adj = new Map<number, Set<number>>();
  for (const page of pages) {
    adj.set(page.id, new Set());
  }
  for (const link of links) {
    if (pageMap.has(link.from_page_id) && pageMap.has(link.to_page_id)) {
      adj.get(link.from_page_id)!.add(link.to_page_id);
      adj.get(link.to_page_id)!.add(link.from_page_id);
    }
  }

  if (pages.length > 0) {
    const visited = new Set<number>();
    const clusters: number[][] = [];

    for (const page of pages) {
      if (visited.has(page.id)) continue;
      // BFS
      const cluster: number[] = [];
      const queue = [page.id];
      visited.add(page.id);
      while (queue.length > 0) {
        const current = queue.shift()!;
        cluster.push(current);
        for (const neighbor of adj.get(current) || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      clusters.push(cluster);
    }

    if (clusters.length > 1) {
      // Sort by size descending; the largest is the "main" cluster
      clusters.sort((a, b) => b.length - a.length);
      for (let i = 1; i < clusters.length; i++) {
        const clusterPages = clusters[i].map(id => pageMap.get(id)!.title).join(', ');
        for (const id of clusters[i]) {
          const page = pageMap.get(id)!;
          issues.push({
            type: 'disconnected',
            severity: 'warning',
            pageId: page.id,
            pageTitle: page.title,
            message: `"${page.title}" is in a disconnected cluster (${clusters[i].length} pages: ${clusterPages.slice(0, 100)})`,
            suggestion: 'Add links connecting this cluster to the main wiki graph',
          });
        }
      }
    }
  }

  // --- d) Missing Reciprocal Links ---
  const linkSet = new Set(links.map(l => `${l.from_page_id}->${l.to_page_id}`));
  for (const link of links) {
    if (!pageMap.has(link.from_page_id) || !pageMap.has(link.to_page_id)) continue;
    const reverse = `${link.to_page_id}->${link.from_page_id}`;
    if (!linkSet.has(reverse)) {
      const fromPage = pageMap.get(link.from_page_id)!;
      const toPage = pageMap.get(link.to_page_id)!;
      issues.push({
        type: 'missing_backlink',
        severity: 'info',
        pageId: link.to_page_id,
        pageTitle: toPage.title,
        message: `"${toPage.title}" is linked from "${fromPage.title}" but doesn't link back`,
        suggestion: `Consider adding a link from "${toPage.title}" back to "${fromPage.title}"`,
      });
    }
  }

  // --- e) Thin Content ---
  for (const page of pages) {
    if (page.content.length < 100) {
      issues.push({
        type: 'thin_content',
        severity: 'warning',
        pageId: page.id,
        pageTitle: page.title,
        message: `"${page.title}" has very short content (${page.content.length} chars)`,
        suggestion: 'Expand this page with more detailed content',
      });
    }
  }

  // --- f) Duplicate Concepts ---
  // Normalize titles and compare
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, '').trim();
  const seen = new Map<string, { id: number; title: string }>();
  for (const page of pages) {
    const norm = normalize(page.title);
    if (!norm) continue;
    const existing = seen.get(norm);
    if (existing) {
      issues.push({
        type: 'duplicate',
        severity: 'warning',
        pageId: page.id,
        pageTitle: page.title,
        message: `"${page.title}" may be a duplicate of "${existing.title}"`,
        suggestion: 'Consider merging these pages',
      });
    } else {
      seen.set(norm, { id: page.id, title: page.title });
    }
  }

  // Also check Levenshtein similarity for near-duplicates
  const titles = Array.from(seen.values());
  const reportedPairs = new Set<string>();
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      const a = normalize(titles[i].title);
      const b = normalize(titles[j].title);
      if (a.length < 3 || b.length < 3) continue;
      const maxLen = Math.max(a.length, b.length);
      const dist = levenshtein(a, b);
      const similarity = 1 - dist / maxLen;
      if (similarity >= 0.85 && similarity < 1) {
        const pairKey = [titles[i].id, titles[j].id].sort().join('-');
        if (reportedPairs.has(pairKey)) continue;
        reportedPairs.add(pairKey);
        issues.push({
          type: 'duplicate',
          severity: 'info',
          pageId: titles[j].id,
          pageTitle: titles[j].title,
          message: `"${titles[i].title}" and "${titles[j].title}" have similar titles (${Math.round(similarity * 100)}% similar)`,
          suggestion: 'Review if these pages cover the same topic',
        });
      }
    }
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const info = issues.filter(i => i.severity === 'info').length;

  return {
    issues,
    summary: {
      errors,
      warnings,
      info,
      total_pages: pages.length,
      total_links: links.length,
    },
    timestamp: new Date().toISOString(),
  };
}

/** Simple Levenshtein distance */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
