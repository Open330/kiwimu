import type { Store } from "../store";

export interface GraphData {
  nodes: Array<{ id: string; title: string; degree: number; type: string }>;
  links: Array<{ source: string; target: string }>;
}

export function buildGraphData(store: Store): GraphData {
  const pages = store.listPages();
  const links = store.getAllLinks();

  const degree = new Map<number, number>();
  for (const page of pages) degree.set(page.id, 0);
  for (const link of links) {
    degree.set(link.from_page_id, (degree.get(link.from_page_id) || 0) + 1);
    degree.set(link.to_page_id, (degree.get(link.to_page_id) || 0) + 1);
  }

  const slugMap = new Map(pages.map((p) => [p.id, p.slug]));

  return {
    nodes: pages.map((p) => ({
      id: p.slug,
      title: p.title,
      degree: degree.get(p.id) || 0,
      type: p.page_type,
    })),
    links: links
      .filter((l) => slugMap.has(l.from_page_id) && slugMap.has(l.to_page_id))
      .map((l) => ({
        source: slugMap.get(l.from_page_id)!,
        target: slugMap.get(l.to_page_id)!,
      })),
  };
}
