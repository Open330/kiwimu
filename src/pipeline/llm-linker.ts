import { chatComplete } from "../llm-client";
import type { Store } from "../store";
import { slugify } from "./chunker";

const LINK_SYSTEM = `You are a wiki editor. Given wiki pages, find cross-link opportunities that were missed.
Return valid JSON only. No markdown fences.`;

const LINK_PROMPT = `These wiki pages exist but may be missing cross-links. Find where one page's content mentions a concept that has its own page.

Pages (slug | title | first 300 chars of content):
{pages}

Return JSON:
{
  "links": [
    {
      "from_slug": "source-page-slug",
      "to_slug": "target-page-slug",
      "anchor_text": "exact phrase in source page to link"
    }
  ]
}

Rules:
- anchor_text MUST be an exact phrase found in the source page content
- Only link genuinely related concepts
- 3-8 links per page where meaningful
- Do NOT link a page to itself`;

export async function llmLinkPages(store: Store): Promise<number> {
  const pages = store.listPages();
  if (pages.length < 2) return 0;

  const batchSize = 30;
  let totalLinks = 0;

  for (let i = 0; i < pages.length; i += batchSize) {
    const batch = pages.slice(i, i + batchSize);
    const pagesText = batch
      .map(p => `${p.slug} | ${p.title} | ${p.content.slice(0, 300).replace(/\n/g, " ")}`)
      .join("\n");

    try {
      const raw = await chatComplete(LINK_SYSTEM, LINK_PROMPT.replace("{pages}", pagesText), 8192);
      let cleaned = raw.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "").trim();

      let result: { links: Array<{ from_slug: string; to_slug: string; anchor_text: string }> };
      try {
        result = JSON.parse(cleaned);
      } catch {
        // Try to repair truncated JSON
        cleaned = cleaned.replace(/,?\s*$/, "]}");
        try {
          result = JSON.parse(cleaned);
        } catch {
          console.log(`    \x1b[33m⚠ 링크 JSON 파싱 실패\x1b[0m`);
          continue;
        }
      }

      const slugToPage = new Map(pages.map(p => [p.slug, p]));

      for (const link of result.links) {
        const fromPage = slugToPage.get(link.from_slug);
        const toPage = slugToPage.get(link.to_slug);
        if (!fromPage || !toPage || fromPage.id === toPage.id) continue;

        const anchor = link.anchor_text;
        if (anchor && fromPage.content.includes(anchor) && !fromPage.content.includes(`[${anchor}]`)) {
          const linkedText = `[${anchor}](/wiki/${link.to_slug})`;
          const newContent = fromPage.content.replace(anchor, linkedText);
          store.updatePageContent(fromPage.id, newContent);
          fromPage.content = newContent;
          store.addLink(fromPage.id, toPage.id, anchor);
          totalLinks++;
        }
      }
    } catch (e: any) {
      console.log(`    \x1b[31m링크 생성 실패: ${e.message}\x1b[0m`);
    }
  }

  return totalLinks;
}
