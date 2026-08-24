import * as cheerio from "cheerio";
import { lookup as systemLookup } from "dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "url";
import { withAbortDeadline } from "../abort";
import { isPublicIp } from "../net";
import pkg from "../../package.json";

const BLOCKED_MSG = "내부 네트워크 주소는 허용되지 않습니다";
const MAX_REDIRECTS = 5;
const REQUEST_DEADLINE_MS = 15_000;
export const MAX_WEB_RESPONSE_BYTES = 10 * 1024 * 1024;
export const WEB_USER_AGENT = `kiwimu/${pkg.version} (learning wiki builder)`;

type ResolvedAddress = { address: string; family?: number };
type PinnedTarget = { url: URL; hostname: string; address: string; family: number };

export type WebResponse = {
  status: number;
  headers: { location?: string };
  body: AsyncIterable<Uint8Array>;
  cancel?: () => void;
};

/** Test seams; production callers should use the one-argument fetchPage API. */
export type WebFetchDependencies = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (target: PinnedTarget, signal: AbortSignal) => Promise<WebResponse>;
  deadlineMs?: number;
  signal?: AbortSignal;
};

function parseUrl(urlStr: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("유효하지 않은 URL입니다");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("http 또는 https URL만 허용됩니다");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (isIpLiteral(hostname) && !isPublicIp(hostname))
  ) {
    throw new Error(BLOCKED_MSG);
  }

  return parsed;
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

async function resolvePublicTarget(
  urlStr: string,
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
): Promise<PinnedTarget> {
  const url = parseUrl(urlStr);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (isIpLiteral(hostname)) {
    return { url, hostname, address: hostname, family: hostname.includes(":") ? 6 : 4 };
  }

  const addresses = await resolve(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error(BLOCKED_MSG);
  }

  const selected = addresses[0]!;
  return {
    url,
    hostname,
    address: selected.address,
    family: selected.family ?? (selected.address.includes(":") ? 6 : 4),
  };
}

/**
 * Validate a URL to prevent SSRF attacks. Blocks non-http(s) schemes,
 * internal names and any DNS answer in a private range.
 */
export async function validateUrl(urlStr: string): Promise<void> {
  const url = parseUrl(urlStr);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteral(hostname)) return;

  // Keep validation useful for UI/CLI preflight: a transient DNS failure is
  // reported by the subsequent fetch, while a resolved private answer blocks.
  try {
    const addresses = await systemLookup(hostname, { all: true });
    if (addresses.some(({ address }) => !isPublicIp(address))) throw new Error(BLOCKED_MSG);
  } catch (error) {
    if (error instanceof Error && error.message === BLOCKED_MSG) throw error;
  }
}

function makePinnedRequest(target: PinnedTarget, onResponse: (response: IncomingMessage) => void): ClientRequest {
  const options = {
    protocol: target.url.protocol,
    hostname: target.hostname,
    port: target.url.port || undefined,
    path: `${target.url.pathname}${target.url.search}`,
    headers: {
      "User-Agent": WEB_USER_AGENT,
      Host: target.url.host,
      Connection: "close",
    },
    // Do not let an agent reuse a socket whose DNS result was checked for a
    // previous request. Each request receives a newly pinned connection.
    agent: false,
    lookup: (
      _hostname: string,
      options: { all?: boolean },
      callback: (error: Error | null, address: string | { address: string; family: number }[], family?: number) => void,
    ) => {
      // Bun/Node may request an `all: true` lookup when automatic address
      // selection is enabled. Return the same single pinned address in that
      // shape too; never hand the client a fresh DNS result.
      if (options.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    },
    // Retain the requested hostname for TLS SNI and certificate validation.
    ...(target.url.protocol === "https:" && !isIpLiteral(target.hostname) ? { servername: target.hostname } : {}),
  };

  return target.url.protocol === "https:"
    ? httpsRequest(options, onResponse)
    : httpRequest(options, onResponse);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request was aborted");
}

async function requestPinned(target: PinnedTarget, signal: AbortSignal): Promise<WebResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }

    let response: IncomingMessage | undefined;
    const request = makePinnedRequest(target, (incoming) => {
      response = incoming;
      const status = incoming.statusCode ?? 0;
      const location = incoming.headers.location;
      resolve({
        status,
        headers: { location: Array.isArray(location) ? location[0] : location },
        body: incoming as AsyncIterable<Uint8Array>,
        cancel: () => {
          signal.removeEventListener("abort", onAbort);
          incoming.destroy();
          request.destroy();
        },
      });
    });

    const onAbort = () => {
      const error = abortError(signal);
      response?.destroy(error);
      request.destroy(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    request.end();
  });
}

async function awaitBeforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedBody(body: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const iterator = body[Symbol.asyncIterator]();
  while (true) {
    const { done, value: chunk } = await awaitBeforeAbort(iterator.next(), signal);
    if (done) break;
    length += chunk.byteLength;
    if (length > MAX_WEB_RESPONSE_BYTES) {
      throw new Error(`Response body exceeds ${MAX_WEB_RESPONSE_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchPage(
  url: string,
  dependencies: WebFetchDependencies = {},
): Promise<{ title: string; html: string }> {
  const resolve = dependencies.resolve ?? (async (hostname: string) => systemLookup(hostname, { all: true }));
  const request = dependencies.request ?? requestPinned;
  const deadlineMs = dependencies.deadlineMs ?? REQUEST_DEADLINE_MS;
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const deadline = withAbortDeadline(
      deadlineMs,
      new Error(`Request timed out after ${deadlineMs}ms`),
      dependencies.signal,
    );
    let response: WebResponse | undefined;
    try {
      // DNS resolution is part of the same absolute per-hop deadline. Resolve
      // immediately before every request and pin the socket to that address.
      const target = await awaitBeforeAbort(
        resolvePublicTarget(currentUrl, resolve),
        deadline.signal,
      );
      response = await awaitBeforeAbort(request(target, deadline.signal), deadline.signal);

      if (response.status >= 300 && response.status < 400) {
        if (!response.headers.location) throw new Error(`Redirect without location header from ${currentUrl}`);
        currentUrl = new URL(response.headers.location, currentUrl).href;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to fetch ${currentUrl}: ${response.status}`);
      }
      const html = await readBoundedBody(response.body, deadline.signal);
      const $ = cheerio.load(html);
      const title = $("title").text().trim() || url;
      const body = $("body").html() || html;
      return { title, html: body };
    } finally {
      deadline.cleanup();
      // Covers redirects, non-2xx, parsing errors, body limits and success.
      response?.cancel?.();
    }
  }

  throw new Error(`Too many redirects fetching ${url}`);
}
