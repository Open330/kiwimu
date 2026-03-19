import { DEMO_SOURCES, DEMO_PAGES, DEMO_LINKS } from "./sample-data";
import type { Store } from "../store";

export async function setupDemo(store: Store): Promise<void> {
  // 1. Insert demo source
  for (const source of DEMO_SOURCES) {
    store.addSource(source.uri, source.type, source.title, source.raw_content);
  }

  // 2. Insert demo pages
  for (const page of DEMO_PAGES) {
    store.addPage(page.slug, page.title, page.content, page.source_id, undefined, page.page_type);
  }

  // 3. Insert demo links
  for (const link of DEMO_LINKS) {
    const fromPage = store.getPage(link.from);
    const toPage = store.getPage(link.to);
    if (fromPage && toPage) {
      store.addLink(fromPage.id, toPage.id, toPage.title);
    }
  }
}
