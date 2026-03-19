import * as cheerio from "cheerio";
import { URL } from "url";

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

/**
 * Validate a URL to prevent SSRF attacks.
 * Blocks private/internal IP ranges and non-http(s) schemes.
 */
export function validateUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("유효하지 않은 URL입니다");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("http 또는 https URL만 허용됩니다");
  }

  const hostname = parsed.hostname;

  // Block IP-based hostnames in private ranges
  // IPv4 pattern
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);
    if (
      a === 127 ||                              // 127.0.0.0/8
      a === 10 ||                               // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||      // 172.16.0.0/12
      (a === 192 && b === 168) ||               // 192.168.0.0/16
      (a === 169 && b === 254) ||               // 169.254.0.0/16
      (a === 0 && b === 0 && c === 0 && d === 0) // 0.0.0.0
    ) {
      throw new Error("내부 네트워크 주소는 허용되지 않습니다");
    }
  }

  // Block common private hostnames
  if (hostname === "localhost" || hostname === "[::1]" || hostname.endsWith(".local")) {
    throw new Error("내부 네트워크 주소는 허용되지 않습니다");
  }
}

export async function fetchPage(url: string): Promise<{ title: string; html: string }> {
  validateUrl(url);
  const resp = await fetch(url, {
    headers: { "User-Agent": "kiwimu/0.4 (learning wiki builder)" },
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
