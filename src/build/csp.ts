import { createHash } from "node:crypto";

/**
 * Extract executable inline script bodies from a generated Kiwi Mu page.
 *
 * This is retained as a diagnostic helper for tests and migration checks. The
 * generated-page policy intentionally never uses these hashes: an HTML
 * injection must not become executable merely because it appears before CSP is
 * calculated. External scripts are covered by `script-src 'self'`.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

  for (const match of html.matchAll(scriptPattern)) {
    const attributes = match[1] || "";
    const script = match[2] || "";
    if (/\bsrc\s*=/i.test(attributes) || !script.trim()) continue;
    const type = /\btype\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2]?.trim().toLowerCase();
    if (type && type !== "module" && !/^(?:application|text)\/(?:javascript|ecmascript)$/.test(type)) continue;

    const digest = createHash("sha256").update(script, "utf8").digest("base64");
    hashes.add(`'sha256-${digest}'`);
  }

  return [...hashes];
}

/**
 * Extract exact inline style-block hashes from a generated Kiwi Mu page.
 *
 * Style attributes are intentionally unsupported: generated markup must use
 * semantic elements, classes, or the `hidden` attribute instead. A style block
 * is allowed only when its exact generated text is present in `style-src`.
 */
export function inlineStyleHashes(html: string): string[] {
  const hashes = new Set<string>();
  const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

  for (const match of html.matchAll(stylePattern)) {
    const style = match[1] || "";
    if (!style.trim()) continue;

    const digest = createHash("sha256").update(style, "utf8").digest("base64");
    hashes.add(`'sha256-${digest}'`);
  }

  return [...hashes];
}

/**
 * Build the per-document CSP used for generated HTML responses.
 *
 * Parent-page JavaScript must be served from this origin. Style attributes are
 * blocked outright, so generated UI state must be represented by classes,
 * semantic elements, or the `hidden` attribute.
 */
export function buildContentSecurityPolicy(html: string): string {
  const styleSources = ["'self'", ...inlineStyleHashes(html)].join(" ");

  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src ${styleSources}`,
    "style-src-attr 'none'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

const CSP_META_PATTERN = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/i;

/**
 * Embed the enforceable subset of the page policy for static hosts such as
 * GitHub Pages, where response headers cannot be configured by this app.
 * `frame-ancestors` is header-only and is therefore deliberately omitted.
 */
export function injectContentSecurityPolicyMeta(html: string): string {
  const withoutPreviousMeta = html.replace(CSP_META_PATTERN, "");
  if (!/<head(?:\s[^>]*)?>/i.test(withoutPreviousMeta)) return withoutPreviousMeta;
  const policy = buildContentSecurityPolicy(withoutPreviousMeta)
    .split(";")
    .map(directive => directive.trim())
    .filter(directive => directive && !directive.startsWith("frame-ancestors "))
    .join("; ");
  const escapedPolicy = policy.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return withoutPreviousMeta.replace(
    /<head(\s[^>]*)?>/i,
    match => `${match}\n    <meta http-equiv="Content-Security-Policy" content="${escapedPolicy}">`,
  );
}
