import * as cheerio from "cheerio";

export interface Section {
  level: number;
  title: string;
  htmlParts: string[];
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4"]);
const SKIP_TAGS = new Set(["nav", "header", "footer", "script", "style", "noscript"]);
const CONTAINER_TAGS = new Set([
  "html", "head", "body", "div", "article", "main", "section", "aside", "details", "summary",
]);

export async function fetchPage(url: string): Promise<{ title: string; html: string }> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "kiwimu/0.2 (learning wiki builder)" },
  });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const html = await resp.text();
  const $ = cheerio.load(html);
  const title = $("title").text().trim() || url;
  const body = $("body").html() || html;
  return { title, html: body };
}

export function extractSections(html: string): Section[] {
  const $ = cheerio.load(html, null, false);
  const sections: Section[] = [];
  let current: Section = { level: 1, title: "Introduction", htmlParts: [] };

  function walk(el: cheerio.AnyNode): void {
    if (el.type === "text") return;
    if (el.type !== "tag") return;

    const tagName = (el as cheerio.Element).tagName.toLowerCase();

    if (SKIP_TAGS.has(tagName)) return;

    if (HEADING_TAGS.has(tagName)) {
      if (current.htmlParts.length > 0) {
        sections.push(current);
      }
      current = {
        level: parseInt(tagName[1]),
        title: $(el).text().trim(),
        htmlParts: [],
      };
      return;
    }

    if (CONTAINER_TAGS.has(tagName)) {
      for (const child of (el as cheerio.Element).children) {
        walk(child);
      }
      return;
    }

    // Content element
    const html = $.html(el)?.trim();
    if (html) {
      current.htmlParts.push(html);
    }
  }

  // Walk root children
  const root = $.root();
  for (const child of root.contents().toArray()) {
    walk(child);
  }

  if (current.htmlParts.length > 0) {
    sections.push(current);
  }

  return sections.filter((s) => s.htmlParts.length > 0);
}
