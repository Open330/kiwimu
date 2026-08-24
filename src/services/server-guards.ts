import path from "path";

const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;

/** Read an integer setting without allowing an unsafe or surprising value. */
export function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(fallback) || fallback < minimum || fallback > maximum) {
    throw new Error("fallback must be inside the configured range");
  }
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export class RequestBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415 = 400) {
    super(message);
    this.name = "RequestBodyError";
  }
}

/** Parse a small JSON request body and reject arrays, null, and oversized input. */
export async function readJsonObject<T extends Record<string, unknown>>(
  request: Request,
  maxBytes: number = DEFAULT_JSON_BODY_LIMIT,
): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("JSON body limit must be a positive safe integer");
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new RequestBodyError("Content-Type application/json이 필요합니다", 415);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyError(`요청 본문은 ${maxBytes}바이트 이하여야 합니다`, 413);
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxBytes) {
          // Stop pulling an unbounded chunked request as soon as the route's
          // limit is crossed. Cancellation failures must not replace the 413.
          try {
            await reader.cancel();
          } catch {
            // The stream may already have failed or closed.
          }
          throw new RequestBodyError(`요청 본문은 ${maxBytes}바이트 이하여야 합니다`, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks, receivedBytes).toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestBodyError("올바른 JSON 본문이 필요합니다");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new RequestBodyError("JSON 객체가 필요합니다");
  }
  return parsed as T;
}

/**
 * Validate an upload using headers only. Call this before admission and before
 * request.formData(), so obvious rejects never allocate a multipart buffer.
 */
export function validateUploadEnvelope(request: Request, maxBodyBytes: number): void {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("upload body limit must be a positive integer");
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    throw new RequestBodyError("올바른 multipart/form-data 요청이 필요합니다");
  }

  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return;
  if (!/^\d+$/.test(rawLength.trim())) {
    throw new RequestBodyError("올바른 Content-Length가 필요합니다");
  }
  const declaredLength = Number(rawLength);
  if (!Number.isSafeInteger(declaredLength)) {
    throw new RequestBodyError("요청 본문 크기가 올바르지 않습니다");
  }
  if (declaredLength > maxBodyBytes) {
    throw new RequestBodyError(`업로드 요청은 ${maxBodyBytes}바이트 이하여야 합니다`, 413);
  }
}

/** Resolve a decoded URL pathname without permitting sibling-prefix traversal. */
export function resolveStaticPath(root: string, pathname: string): string | null {
  if (pathname.includes("\0")) return null;
  const resolvedRoot = path.resolve(root);
  const relativeRequest = pathname.replace(/^\/+/, "");
  const candidate = path.resolve(resolvedRoot, relativeRequest);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return candidate;
  }
  return null;
}
