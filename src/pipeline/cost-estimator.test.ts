import { expect, test, describe } from "bun:test";
import { estimateTokens, estimateChunkCount, estimateIngest, formatEstimatedCost } from "./cost-estimator";

describe("cost-estimator", () => {
  test("estimateTokens is ~chars/4 and zero for empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("estimateChunkCount is at least 1 and grows with size", () => {
    expect(estimateChunkCount("")).toBe(0);
    expect(estimateChunkCount("short")).toBe(1);
    expect(estimateChunkCount("x".repeat(45000))).toBe(3);
  });

  test("estimateIngest returns positive token + cost estimates", () => {
    const est = estimateIngest("x".repeat(40000), "gemini", "gemini-3.1-flash-lite");
    expect(est.sizeChars).toBe(40000);
    expect(est.chunks).toBeGreaterThanOrEqual(2);
    expect(est.promptTokens).toBeGreaterThan(0);
    expect(est.completionTokens).toBeGreaterThan(0);
    expect(est.totalTokens).toBe(est.promptTokens + est.completionTokens);
    expect(est.estimatedCostUsd).not.toBeNull();
    expect(est.estimatedCostUsd!).toBeGreaterThanOrEqual(0);
  });

  test("larger documents estimate more tokens", () => {
    const small = estimateIngest("x".repeat(5000), "openai", "gpt-5.4");
    const large = estimateIngest("x".repeat(50000), "openai", "gpt-5.4");
    expect(large.totalTokens).toBeGreaterThan(small.totalTokens);
  });

  test("empty text yields a zero-cost estimate", () => {
    const est = estimateIngest("", "gemini", "custom-model");
    expect(est.sizeChars).toBe(0);
    expect(est.estimatedCostUsd).toBe(0);
  });

  test("unknown custom model keeps token estimate but omits a dollar amount", () => {
    const est = estimateIngest("x".repeat(5000), "gemini", "custom-model");
    expect(est.totalTokens).toBeGreaterThan(0);
    expect(est.estimatedCostUsd).toBeNull();
    expect(formatEstimatedCost(est.estimatedCostUsd)).toBe("가격 정보 없음");
  });
});
