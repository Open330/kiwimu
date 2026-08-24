import { expect, test, describe } from "bun:test";
import { fetchPage, MAX_WEB_RESPONSE_BYTES, validateUrl, WEB_USER_AGENT, type WebResponse } from "./web";
import { isPrivateIp, isPublicIp } from "../net";
import pkg from "../../package.json";

test("outbound User-Agent reports the installed package version", () => {
  expect(WEB_USER_AGENT).toBe(`kiwimu/${pkg.version} (learning wiki builder)`);
});

describe("validateUrl", () => {
  test("정상 HTTP URL 허용", async () => {
    await expect(validateUrl("http://example.com")).resolves.toBeUndefined();
  });
  test("정상 HTTPS URL 허용", async () => {
    await expect(validateUrl("https://example.com/page")).resolves.toBeUndefined();
  });
  test("localhost 차단", async () => {
    await expect(validateUrl("http://localhost:3000")).rejects.toThrow();
  });
  test("127.0.0.1 차단", async () => {
    await expect(validateUrl("http://127.0.0.1")).rejects.toThrow();
  });
  test("10.x.x.x 차단", async () => {
    await expect(validateUrl("http://10.0.0.1")).rejects.toThrow();
  });
  test("172.16.x.x 차단", async () => {
    await expect(validateUrl("http://172.16.0.1")).rejects.toThrow();
  });
  test("192.168.x.x 차단", async () => {
    await expect(validateUrl("http://192.168.1.1")).rejects.toThrow();
  });
  test("169.254.x.x 차단", async () => {
    await expect(validateUrl("http://169.254.169.254")).rejects.toThrow();
  });
  test("file:// 프로토콜 차단", async () => {
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow();
  });
  test("ftp:// 프로토콜 차단", async () => {
    await expect(validateUrl("ftp://example.com")).rejects.toThrow();
  });
  test(".local 도메인 차단", async () => {
    await expect(validateUrl("http://server.local")).rejects.toThrow();
  });
  test("0.0.0.0 차단", async () => {
    await expect(validateUrl("http://0.0.0.0")).rejects.toThrow();
  });
  test("10진수 IPv4 인코딩 차단 (http://2130706433 = 127.0.0.1)", async () => {
    await expect(validateUrl("http://2130706433")).rejects.toThrow();
  });
  test("16진수 IPv4 인코딩 차단 (http://0x7f000001 = 127.0.0.1)", async () => {
    await expect(validateUrl("http://0x7f000001")).rejects.toThrow();
  });
  test("IPv6 루프백 차단", async () => {
    await expect(validateUrl("http://[::1]:8080")).rejects.toThrow();
  });
  test("IPv6 ULA 차단 (fd00::/8)", async () => {
    await expect(validateUrl("http://[fd00::1]")).rejects.toThrow();
  });
  test("IPv4-mapped IPv6 차단", async () => {
    await expect(validateUrl("http://[::ffff:127.0.0.1]")).rejects.toThrow();
  });
  test("CGNAT 대역 차단 (100.64.0.0/10)", async () => {
    await expect(validateUrl("http://100.64.0.1")).rejects.toThrow();
  });
  test(".internal 도메인 차단", async () => {
    await expect(validateUrl("http://metadata.google.internal")).rejects.toThrow();
  });
  test("비전역 IP literal 차단", async () => {
    for (const url of [
      "http://255.255.255.255", "http://224.0.0.251", "http://198.18.0.1",
      "http://[::127.0.0.1]", "http://[ff02::1]",
    ]) {
      await expect(validateUrl(url)).rejects.toThrow("내부 네트워크 주소");
    }
  });
});

describe("isPrivateIp", () => {
  test("사설/내부 대역 판정", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1",
      "169.254.169.254", "0.0.0.0", "100.64.0.1", "100.127.255.255",
      "::1", "::", "fd12:3456::1", "fc00::1", "fe80::1",
      "[::1]", "::ffff:192.168.0.1",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  test("공인 주소는 통과", () => {
    for (const ip of [
      "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "192.169.0.1",
      "2606:4700:4700::1111", "::ffff:8.8.8.8",
    ]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});

describe("isPublicIp", () => {
  test("공인 전역 유니캐스트 IPv4/IPv6만 허용한다", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "[2606:4700:4700::1111]"]) {
      expect(isPublicIp(ip)).toBe(true);
    }
  });

  test("브로드캐스트·멀티캐스트·문서화·벤치마크·내장 사설 주소를 거부한다", () => {
    for (const ip of [
      "255.255.255.255", "224.0.0.251", "198.18.0.1", "192.0.2.1", "203.0.113.1",
      "::127.0.0.1", "::ffff:127.0.0.1", "ff02::1", "2001:db8::1", "2002:7f00:1::1",
    ]) {
      expect(isPublicIp(ip)).toBe(false);
    }
  });
});

function response(status: number, html = "<title>문서</title><body>내용</body>", location?: string): WebResponse {
  return {
    status,
    headers: location ? { location } : {},
    body: (async function* () { yield Buffer.from(html); })(),
  };
}

describe("fetchPage", () => {
  test("각 요청을 직전에 확인한 공인 IP로 고정하고 리다이렉트도 다시 확인한다", async () => {
    const resolutions: string[] = [];
    const targets: { hostname: string; address: string }[] = [];
    let firstResponseCancelled = false;
    const pages = [
      { ...response(302, "", "https://second.example/article"), cancel: () => { firstResponseCancelled = true; } },
      response(200),
    ];

    const page = await fetchPage("https://first.example/start", {
      resolve: async (hostname) => {
        resolutions.push(hostname);
        return hostname === "first.example"
          ? [{ address: "8.8.8.8", family: 4 }]
          : [{ address: "2606:4700:4700::1111", family: 6 }];
      },
      request: async (target) => {
        targets.push({ hostname: target.hostname, address: target.address });
        return pages.shift()!;
      },
    });

    expect(page).toEqual({ title: "문서", html: "내용" });
    expect(resolutions).toEqual(["first.example", "second.example"]);
    expect(targets).toEqual([
      { hostname: "first.example", address: "8.8.8.8" },
      { hostname: "second.example", address: "2606:4700:4700::1111" },
    ]);
    expect(firstResponseCancelled).toBe(true);
  });

  test("DNS 답변에 내부 IP가 하나라도 있으면 연결 전에 거부한다", async () => {
    let requested = false;
    await expect(fetchPage("https://rebind.example", {
      resolve: async () => [{ address: "8.8.8.8" }, { address: "127.0.0.1" }],
      request: async () => {
        requested = true;
        return response(200);
      },
    })).rejects.toThrow("내부 네트워크 주소");
    expect(requested).toBe(false);
  });

  test("응답 본문 한도를 초과하면 파싱 전에 거부한다", async () => {
    let cancelled = false;
    await expect(fetchPage("https://large.example", {
      resolve: async () => [{ address: "8.8.8.8" }],
      request: async () => ({
        status: 200,
        headers: {},
        body: (async function* () {
          yield new Uint8Array(MAX_WEB_RESPONSE_BYTES + 1);
        })(),
        cancel: () => { cancelled = true; },
      }),
    })).rejects.toThrow("Response body exceeds");
    expect(cancelled).toBe(true);
  });

  test("non-2xx 응답도 즉시 취소한다", async () => {
    let cancelled = false;
    await expect(fetchPage("https://error.example", {
      resolve: async () => [{ address: "8.8.8.8" }],
      request: async () => ({ ...response(503), cancel: () => { cancelled = true; } }),
    })).rejects.toThrow("503");
    expect(cancelled).toBe(true);
  });

  test("slow-drip 본문도 절대 마감에 도달하면 취소한다", async () => {
    let cancelled = false;
    await expect(fetchPage("https://slow.example", {
      deadlineMs: 10,
      resolve: async () => [{ address: "8.8.8.8" }],
      request: async () => ({
        status: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from("<body>first byte</body>");
          await new Promise<never>(() => {});
        })(),
        cancel: () => { cancelled = true; },
      }),
    })).rejects.toThrow("Request timed out after 10ms");
    expect(cancelled).toBe(true);
  });

  test("DNS 해석도 동일한 절대 마감시간 안에서 중단한다", async () => {
    let requested = false;
    await expect(fetchPage("https://dns-timeout.example", {
      deadlineMs: 10,
      resolve: async () => new Promise<never>(() => {}),
      request: async () => {
        requested = true;
        return response(200);
      },
    })).rejects.toThrow("Request timed out after 10ms");
    expect(requested).toBe(false);
  });

  test("외부 취소 신호가 per-hop deadline과 합성되고 응답을 닫는다", async () => {
    const reason = new Error("server shutdown");
    const controller = new AbortController();
    let cancelled = false;
    const completion = fetchPage("https://cancel.example", {
      deadlineMs: 10_000,
      signal: controller.signal,
      resolve: async () => [{ address: "8.8.8.8" }],
      request: async () => ({
        status: 200,
        headers: {},
        body: (async function* () { await new Promise<never>(() => {}); })(),
        cancel: () => { cancelled = true; },
      }),
    });

    await Bun.sleep(0);
    controller.abort(reason);
    await expect(completion).rejects.toBe(reason);
    expect(cancelled).toBe(true);
  });
});
