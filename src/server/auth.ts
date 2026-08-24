import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isPrivateIp } from "../net";
import { apiJson } from "./http";

export const AUTH_COOKIE_NAME = "kiwi-auth";
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export type AuthenticationMethod = "query" | "bearer" | "cookie";

export interface RequestSecurityOptions {
  forceHttps?: boolean;
  trustProxy?: boolean;
  peerAddress?: string | null;
}

export interface RequestSecurityContext {
  secure: boolean;
  origin: string;
}
const MIN_TOKEN_LENGTH = 16;
const TOKEN_READ_ATTEMPTS = 100;
const TOKEN_RETRY_DELAY_MS = 5;
const UUID_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

class UnsafeAuthTokenPathError extends Error {
  constructor(tokenFile: string) {
    super(`Authentication token path must be a regular file: ${tokenFile}`);
    this.name = "UnsafeAuthTokenPathError";
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertSafeExistingTokenPath(tokenFile: string): boolean {
  try {
    const entry = lstatSync(tokenFile);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new UnsafeAuthTokenPathError(tokenFile);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function openRegularToken(tokenFile: string, flags: number): number {
  const descriptor = openSync(tokenFile, flags | NO_FOLLOW);
  if (!fstatSync(descriptor).isFile()) {
    closeSync(descriptor);
    throw new UnsafeAuthTokenPathError(tokenFile);
  }
  return descriptor;
}

function readValidToken(tokenFile: string): string | null {
  let descriptor: number | null = null;
  try {
    if (!assertSafeExistingTokenPath(tokenFile)) return null;
    descriptor = openRegularToken(tokenFile, constants.O_RDONLY);
    const token = readFileSync(descriptor, "utf-8").trim();
    if (token.length < MIN_TOKEN_LENGTH) return null;
    // Generated tokens are UUIDs. A UUID-looking prefix can be observed while
    // another process is still completing its first write, so never accept it
    // as a legacy arbitrary token until the full shape is present.
    if (token.includes("-") && /^[0-9a-f-]+$/i.test(token) && !UUID_TOKEN_PATTERN.test(token)) return null;
    try {
      fchmodSync(descriptor, 0o600);
    } catch {
      // A read-only deployment can still use an already valid token.
    }
    return token;
  } catch (error) {
    if (error instanceof UnsafeAuthTokenPathError) throw error;
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function waitForValidToken(tokenFile: string): string | null {
  for (let attempt = 0; attempt < TOKEN_READ_ATTEMPTS; attempt++) {
    const token = readValidToken(tokenFile);
    if (token) return token;
    sleepSync(TOKEN_RETRY_DELAY_MS);
  }
  return null;
}

function writeCompleteToken(fileDescriptor: number, token: string): void {
  const bytes = Buffer.from(token, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(fileDescriptor, bytes, offset, bytes.byteLength - offset);
  }
  fsyncSync(fileDescriptor);
}

function createTokenExclusive(tokenFile: string, token: string): boolean {
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(
      tokenFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    writeCompleteToken(fileDescriptor, token);
    return true;
  } catch (error) {
    if (isAlreadyExistsError(error)) return false;
    throw error;
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
  }
}

/** Repair a pre-existing empty/partial token file under a cross-process lock. */
function repairInvalidTokenFile(tokenFile: string, token: string): string | null {
  const lockFile = `${tokenFile}.lock`;
  let lockDescriptor: number | null = null;
  try {
    lockDescriptor = openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if (isAlreadyExistsError(error)) return null;
    throw error;
  }

  try {
    const recovered = readValidToken(tokenFile);
    if (recovered) return recovered;

    let tokenDescriptor: number | null = null;
    try {
      if (!assertSafeExistingTokenPath(tokenFile)) return null;
      tokenDescriptor = openRegularToken(tokenFile, constants.O_WRONLY);
      fchmodSync(tokenDescriptor, 0o600);
      ftruncateSync(tokenDescriptor, 0);
      writeCompleteToken(tokenDescriptor, token);
    } finally {
      if (tokenDescriptor !== null) closeSync(tokenDescriptor);
    }
    return token;
  } finally {
    if (lockDescriptor !== null) closeSync(lockDescriptor);
    try {
      unlinkSync(lockFile);
    } catch {
      // Another process will either observe the valid token or fail clearly.
    }
  }
}

export function loadOrCreateAuthToken(tokenFile: string, envToken?: string): string {
  if (envToken !== undefined) {
    const configuredToken = envToken.trim();
    if (configuredToken && configuredToken.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `KIWIMU_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters when configured`,
      );
    }
    if (configuredToken) return configuredToken;
  }
  // Refuse links and special files before any read, permission repair, or write.
  assertSafeExistingTokenPath(tokenFile);
  const cached = readValidToken(tokenFile);
  if (cached) return cached;

  const fresh = randomUUID();
  try {
    if (createTokenExclusive(tokenFile, fresh)) return fresh;
    const concurrent = waitForValidToken(tokenFile);
    if (concurrent) return concurrent;

    const repaired = repairInvalidTokenFile(tokenFile, fresh);
    if (repaired) return repaired;
    const repairedByPeer = waitForValidToken(tokenFile);
    if (repairedByPeer) return repairedByPeer;
  } catch (error) {
    throw new Error(
      `Unable to initialize a shared authentication token at ${tokenFile}`,
      { cause: error },
    );
  }
  throw new Error(`Unable to initialize a shared authentication token at ${tokenFile}`);
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  const part = raw.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  if (!part) return null;
  try {
    return decodeURIComponent(part.slice(name.length + 1));
  } catch {
    return null;
  }
}

/** Constant-time token comparison to avoid exposing a timing oracle. */
export function safeEqual(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}

/**
 * Resolve the browser-visible request security context without trusting proxy
 * headers by default. `X-Forwarded-Proto` is accepted only when proxy trust is
 * explicitly enabled and the immediate peer is private/internal.
 */
export function resolveRequestSecurity(
  req: Request,
  url: URL,
  options: RequestSecurityOptions = {},
): RequestSecurityContext {
  const trustedProxy = options.trustProxy === true &&
    Boolean(options.peerAddress) &&
    isPrivateIp(options.peerAddress!);
  const forwardedProto = trustedProxy
    ? req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
    : undefined;
  const secure = url.protocol === "https:" || options.forceHttps === true || forwardedProto === "https";
  const externalUrl = new URL(url);
  if (secure) externalUrl.protocol = "https:";
  return { secure, origin: externalUrl.origin };
}

export class ServerAuth {
  constructor(readonly token: string) {}

  authenticationMethod(req: Request, url: URL): AuthenticationMethod | null {
    const queryToken = url.searchParams.get("token");
    if (safeEqual(queryToken, this.token)) return "query";

    const authHeader = req.headers.get("Authorization");
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    if (safeEqual(bearerToken, this.token)) return "bearer";

    const cookieToken = readCookie(req, AUTH_COOKIE_NAME);
    return safeEqual(cookieToken, this.token) ? "cookie" : null;
  }

  isAuthenticated(req: Request, url: URL): boolean {
    return this.authenticationMethod(req, url) !== null;
  }

  /**
   * Cookie credentials are ambient browser authority, so unsafe requests must
   * prove an exact same-origin initiator. Explicit query/Bearer credentials are
   * not ambient and remain usable by non-browser API clients.
   */
  isRequestAuthorized(req: Request, url: URL, expectedOrigin: string = url.origin): boolean {
    const method = this.authenticationMethod(req, url);
    if (!method) return false;
    if (method !== "cookie" || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return true;
    }

    const origin = req.headers.get("origin");
    if (!origin || origin === "null") return false;
    try {
      return new URL(origin).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  /**
   * Cost-bearing GETs need an explicit same-origin browser context even though
   * GET is normally exempt from CSRF checks. Bearer/query clients carry
   * non-ambient authority and remain compatible.
   */
  isCostlyReadAuthorized(req: Request, url: URL, expectedOrigin: string = url.origin): boolean {
    const method = this.authenticationMethod(req, url);
    if (!method) return false;
    if (method !== "cookie") return true;

    const origin = req.headers.get("origin");
    if (origin !== null) {
      if (origin === "null") return false;
      try {
        return new URL(origin).origin === expectedOrigin;
      } catch {
        return false;
      }
    }
    return req.headers.get("sec-fetch-site")?.toLowerCase() === "same-origin";
  }

  cookieHeader(secure: boolean): string {
    return `${AUTH_COOKIE_NAME}=${encodeURIComponent(this.token)}; Path=/; Max-Age=${AUTH_COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
  }

  /**
   * Exchange a browser page's query token for an HttpOnly cookie and remove the
   * token from browser history and future Referer headers.
   */
  pageTokenRedirect(req: Request, url: URL, secure: boolean = url.protocol === "https:"): Response | null {
    const queryToken = url.searchParams.get("token");
    if (queryToken === null || req.method !== "GET" || url.pathname.startsWith("/api/")) {
      return null;
    }
    if (!safeEqual(queryToken, this.token)) {
      return apiJson(
        { error: "Unauthorized" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }

    url.searchParams.delete("token");
    const query = url.searchParams.toString();
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + (query ? `?${query}` : ""),
        "Set-Cookie": this.cookieHeader(secure),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
}
