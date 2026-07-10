import * as cheerio from "cheerio";
import { URL } from "url";
import { lookup } from "dns/promises";
import { isPrivateIp } from "../net";

const BLOCKED_MSG = "내부 네트워크 주소는 허용되지 않습니다";

/**
 * Validate a URL to prevent SSRF attacks.
 * Blocks non-http(s) schemes, private/internal IP literals (the WHATWG URL
 * parser already normalizes decimal/hex/octal IPv4 forms like
 * `http://2130706433` to dotted-quad), internal hostnames, and — for named
 * hosts — DNS answers that resolve into private ranges.
 */
export async function validateUrl(urlStr: string): Promise<void> {
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

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error(BLOCKED_MSG);
  }

  if (isPrivateIp(hostname)) {
    throw new Error(BLOCKED_MSG);
  }

  // Named host: resolve and check every DNS answer so a hostname pointing
  // at an internal IP can't slip through. Unresolvable hosts are left for
  // fetch() to fail on naturally.
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
  if (!isIpLiteral) {
    let addrs: { address: string }[];
    try {
      addrs = await lookup(hostname, { all: true });
    } catch {
      return;
    }
    if (addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error(BLOCKED_MSG);
    }
  }
}

export async function fetchPage(url: string): Promise<{ title: string; html: string }> {
  await validateUrl(url);

  let currentUrl = url;
  const maxRedirects = 5;

  for (let i = 0; i <= maxRedirects; i++) {
    const resp = await fetch(currentUrl, {
      headers: { "User-Agent": "kiwimu/0.4 (learning wiki builder)" },
      redirect: "manual",
    });

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) throw new Error(`Redirect without location header from ${currentUrl}`);
      // Resolve relative redirect URLs
      const redirectUrl = new URL(location, currentUrl).href;
      await validateUrl(redirectUrl); // Re-validate redirect target to prevent SSRF bypass
      currentUrl = redirectUrl;
      continue;
    }

    if (!resp.ok) throw new Error(`Failed to fetch ${currentUrl}: ${resp.status}`);
    const html = await resp.text();
    const $ = cheerio.load(html);
    const title = $("title").text().trim() || url;
    const body = $("body").html() || html;
    return { title, html: body };
  }

  throw new Error(`Too many redirects fetching ${url}`);
}
