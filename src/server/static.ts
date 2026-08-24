import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { resolveStaticPath } from "../services/server-guards";
import { applyDocumentSecurityHeaders, htmlResponse } from "./http";

const COMPRESSIBLE_STATIC_PATH = /\.(?:css|csv|htm|js|json|mjs|svg|txt|xml)$/i;
const MINIMUM_COMPRESSION_SIZE = 1_024;

interface StaticRequestOptions {
  request: Request;
  url: URL;
  siteDir: string;
  isAuthenticated: (request: Request, url: URL) => boolean;
}

export function injectLiveMarker(html: string): string {
  if (html.includes('name="kiwi-live"')) return html;
  return html.replace("</head>", '<meta name="kiwi-live" content="true"></head>');
}

function acceptsGzip(value: string | null): boolean {
  if (!value) return false;
  let gzipQuality: number | undefined;
  let wildcardQuality: number | undefined;

  for (const part of value.split(",")) {
    const [rawEncoding, ...parameters] = part.trim().split(";");
    const encoding = rawEncoding?.trim().toLowerCase();
    if (encoding !== "gzip" && encoding !== "*") continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/i.exec(parameter);
      if (match) quality = Number(match[1]);
      else if (/^\s*q\s*=/i.test(parameter)) quality = 0;
    }
    if (encoding === "gzip") gzipQuality = quality;
    else wildcardQuality = quality;
  }

  return (gzipQuality ?? wildcardQuality ?? 0) > 0;
}

function weakEntityTag(size: number, lastModified: number): string {
  return `W/"${size.toString(16)}-${Math.trunc(lastModified).toString(16)}"`;
}

function requestHasEntityTag(value: string | null, entityTag: string): boolean {
  if (!value) return false;
  return value.split(",").some(candidate => candidate.trim() === "*" || candidate.trim() === entityTag);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

export async function serveStaticRequest(options: StaticRequestOptions): Promise<Response> {
  const { request, url, siteDir, isAuthenticated } = options;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (pathname === "/") pathname = "/index.html";

  const resolved = resolveStaticPath(siteDir, pathname);
  if (!resolved) return new Response("Forbidden", { status: 403 });

  // Lexical containment alone is insufficient because Bun.file follows
  // symlinks. Resolve both paths before opening the file so a restored or
  // copied site tree cannot publish files outside its configured root.
  let realSiteDir: string;
  let realResolved: string;
  try {
    realSiteDir = realpathSync(siteDir);
    realResolved = realpathSync(resolved);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  if (!isInsideRoot(realSiteDir, realResolved)) {
    return new Response("Forbidden", { status: 403 });
  }

  const staticFile = Bun.file(realResolved);
  if (!(await staticFile.exists())) return new Response("Not Found", { status: 404 });

  if (pathname.endsWith(".html")) {
    const authenticated = isAuthenticated(request, url);
    const originalHtml = await staticFile.text();
    const finalHtml = authenticated ? injectLiveMarker(originalHtml) : originalHtml;
    return htmlResponse(
      finalHtml,
      { headers: { "Cache-Control": authenticated ? "no-store" : "no-cache" } },
      request.method !== "HEAD",
    );
  }

  const entityTag = weakEntityTag(staticFile.size, staticFile.lastModified);
  const compressible = staticFile.size >= MINIMUM_COMPRESSION_SIZE && COMPRESSIBLE_STATIC_PATH.test(pathname);
  const headers = applyDocumentSecurityHeaders(new Headers({
    "Cache-Control": "public, no-cache",
    "ETag": entityTag,
    "Last-Modified": new Date(staticFile.lastModified).toUTCString(),
    ...(compressible ? { Vary: "Accept-Encoding" } : {}),
  }));
  if (staticFile.type) headers.set("Content-Type", staticFile.type);
  if (requestHasEntityTag(request.headers.get("If-None-Match"), entityTag)) {
    return new Response(null, { status: 304, headers });
  }

  const gzip = compressible && acceptsGzip(request.headers.get("Accept-Encoding"));
  if (gzip) headers.set("Content-Encoding", "gzip");
  const body = request.method === "HEAD"
    ? null
    : gzip
      ? staticFile.stream().pipeThrough(new CompressionStream("gzip"))
      : staticFile;
  return new Response(body, { headers });
}
