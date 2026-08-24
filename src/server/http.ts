import { buildContentSecurityPolicy } from "../build/csp";
import { RequestBodyError } from "../services/server-guards";

const DOCUMENT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function apiJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(data, { ...init, headers });
}

export function inputErrorResponse(error: unknown): Response | null {
  if (!(error instanceof RequestBodyError)) return null;
  return apiJson({ error: error.message }, { status: error.status });
}

export function applyDocumentSecurityHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(DOCUMENT_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

/**
 * Respond with the exact HTML used to derive CSP script hashes.
 *
 * Callers must finish all HTML mutation before invoking this helper. This keeps
 * dynamic pages and generated static pages on the same hash-based policy.
 */
export function htmlResponse(
  html: string,
  init: ResponseInit = {},
  includeBody: boolean = true,
): Response {
  const headers = applyDocumentSecurityHeaders(new Headers(init.headers));
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", buildContentSecurityPolicy(html));
  return new Response(includeBody ? html : null, { ...init, headers });
}
