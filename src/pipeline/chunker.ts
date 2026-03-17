import TurndownService from "turndown";
import type { Section } from "../ingest/web";
import type { Store } from "../store";

const turndown = new TurndownService({ headingStyle: "atx" });
turndown.remove(["script", "style"]);

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

const STOP_TITLES = new Set([
  "introduction", "overview", "summary", "conclusion", "references",
  "bibliography", "appendix", "abstract", "preface", "contents",
  "table of contents", "index", "acknowledgments", "notes",
]);

export function cleanTitle(title: string): string {
  return title
    .replace(/^\s*(Chapter\s+)?\d+(\.\d+)*\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function chunkSections(sections: Section[], sourceId: number, store: Store, minWords = 30): number {
  let count = 0;

  for (const section of sections) {
    const title = cleanTitle(section.title);
    if (!title) continue;

    const slug = slugify(title);
    if (!slug) continue;

    const htmlContent = section.htmlParts.join("\n");
    if (!htmlContent.trim()) continue;

    const content = turndown.turndown(htmlContent).trim();
    const wordCount = content.split(/\s+/).length;

    if (wordCount < minWords) continue;
    if (STOP_TITLES.has(slug) || STOP_TITLES.has(title.toLowerCase())) {
      if (wordCount < 100) continue;
    }

    const existing = store.getPage(slug);
    if (existing) {
      store.updatePageContent(existing.id, existing.content + "\n\n" + content);
    } else {
      store.addPage(slug, title, content, sourceId, slug);
      count++;
    }
  }

  return count;
}
