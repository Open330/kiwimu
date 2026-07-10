import { expect, test, describe } from "bun:test";
import { validateUrl } from "./web";
import { isPrivateIp } from "../net";

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
