import { describe, expect, test } from "bun:test";
import {
  RequestBodyError,
  readBoundedInteger,
  readJsonObject,
  resolveStaticPath,
  validateUploadEnvelope,
} from "./server-guards";

describe("readBoundedInteger", () => {
  test("accepts only decimal integers inside the safe range", () => {
    expect(readBoundedInteger("3", 1, 1, 8)).toBe(3);
    expect(readBoundedInteger(undefined, 1, 1, 8)).toBe(1);
    expect(readBoundedInteger("0", 1, 1, 8)).toBe(1);
    expect(readBoundedInteger("999", 1, 1, 8)).toBe(1);
    expect(readBoundedInteger("2.5", 1, 1, 8)).toBe(1);
  });
});

describe("readJsonObject", () => {
  test("parses an object and rejects malformed or non-object JSON", async () => {
    const jsonRequest = (body: string) => new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body,
    });
    const request = jsonRequest('{"name":"kiwi"}');
    expect(await readJsonObject(request)).toEqual({ name: "kiwi" });

    await expect(readJsonObject(jsonRequest("{")))
      .rejects.toBeInstanceOf(RequestBodyError);
    await expect(readJsonObject(jsonRequest("[]")))
      .rejects.toBeInstanceOf(RequestBodyError);
  });

  test("rejects JSON-shaped simple-request bodies before consuming them", async () => {
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
      const request = new Request("http://localhost", {
        method: "POST",
        headers: contentType ? { "Content-Type": contentType } : undefined,
        body: '{"name":"kiwi"}',
      });
      try {
        await readJsonObject(request);
        throw new Error("expected request to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(RequestBodyError);
        expect((error as RequestBodyError).status).toBe(415);
        expect(request.bodyUsed).toBeFalse();
      }
    }
  });

  test("rejects actual payloads over the configured limit", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "12345" }),
    });
    try {
      await readJsonObject(request, 5);
      throw new Error("expected request to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBodyError);
      expect((error as RequestBodyError).status).toBe(413);
    }
  });

  test("stops a chunked body immediately after crossing the byte limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    try {
      await readJsonObject(request, 7);
      throw new Error("expected request to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBodyError);
      expect((error as RequestBodyError).status).toBe(413);
    }
    expect(pulls).toBe(2);
    expect(cancelled).toBeTrue();
  });

  test("counts UTF-8 bytes while preserving valid multibyte JSON", async () => {
    const body = JSON.stringify({ name: "키위" });
    const encodedBytes = Buffer.byteLength(body, "utf8");
    const request = () => new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(await readJsonObject(request(), encodedBytes)).toEqual({ name: "키위" });
    await expect(readJsonObject(request(), encodedBytes - 1)).rejects.toMatchObject({ status: 413 });
  });
});

describe("validateUploadEnvelope", () => {
  test("rejects the content type and declared size without consuming the body", () => {
    const wrongType = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(() => validateUploadEnvelope(wrongType, 100)).toThrow(RequestBodyError);

    const oversized = new Request("http://localhost/upload", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=kiwi",
        "content-length": "101",
      },
      body: "unread body",
    });
    try {
      validateUploadEnvelope(oversized, 100);
      throw new Error("expected request to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBodyError);
      expect((error as RequestBodyError).status).toBe(413);
      expect(oversized.bodyUsed).toBe(false);
    }
  });

  test("admits a bounded multipart request without reading it", () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=kiwi",
        "content-length": "50",
      },
      body: "unread body",
    });
    expect(() => validateUploadEnvelope(request, 100)).not.toThrow();
    expect(request.bodyUsed).toBe(false);
  });
});

describe("resolveStaticPath", () => {
  test("keeps normal files inside the site root", () => {
    expect(resolveStaticPath("/tmp/wiki-site", "/static/app.js")).toBe("/tmp/wiki-site/static/app.js");
  });

  test("rejects traversal even when a sibling shares the root prefix", () => {
    expect(resolveStaticPath("/tmp/wiki-site", "/../wiki-site-backup/secret")).toBeNull();
    expect(resolveStaticPath("/tmp/wiki-site", "/../../etc/passwd")).toBeNull();
    expect(resolveStaticPath("/tmp/wiki-site", "/bad\0path")).toBeNull();
  });
});
