import { expect, test, describe } from "bun:test";
import { validateUrl } from "./web";

describe("validateUrl", () => {
  test("정상 HTTP URL 허용", () => {
    expect(() => validateUrl("http://example.com")).not.toThrow();
  });
  test("정상 HTTPS URL 허용", () => {
    expect(() => validateUrl("https://example.com/page")).not.toThrow();
  });
  test("localhost 차단", () => {
    expect(() => validateUrl("http://localhost:3000")).toThrow();
  });
  test("127.0.0.1 차단", () => {
    expect(() => validateUrl("http://127.0.0.1")).toThrow();
  });
  test("10.x.x.x 차단", () => {
    expect(() => validateUrl("http://10.0.0.1")).toThrow();
  });
  test("172.16.x.x 차단", () => {
    expect(() => validateUrl("http://172.16.0.1")).toThrow();
  });
  test("192.168.x.x 차단", () => {
    expect(() => validateUrl("http://192.168.1.1")).toThrow();
  });
  test("169.254.x.x 차단", () => {
    expect(() => validateUrl("http://169.254.169.254")).toThrow();
  });
  test("file:// 프로토콜 차단", () => {
    expect(() => validateUrl("file:///etc/passwd")).toThrow();
  });
  test("ftp:// 프로토콜 차단", () => {
    expect(() => validateUrl("ftp://example.com")).toThrow();
  });
  test(".local 도메인 차단", () => {
    expect(() => validateUrl("http://server.local")).toThrow();
  });
  test("0.0.0.0 차단", () => {
    expect(() => validateUrl("http://0.0.0.0")).toThrow();
  });
});
