import { expect, test, describe } from "bun:test";
import { estimateTokens, estimateChunkCount, estimateIngest } from "./cost-estimator";

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
    const est = estimateIngest("x".repeat(40000), "gemini");
    expect(est.sizeChars).toBe(40000);
    expect(est.chunks).toBeGreaterThanOrEqual(2);
    expect(est.promptTokens).toBeGreaterThan(0);
    expect(est.completionTokens).toBeGreaterThan(0);
    expect(est.totalTokens).toBe(est.promptTokens + est.completionTokens);
    expect(est.estimatedCostUsd).toBeGreaterThanOrEqual(0);
  });

  test("larger documents estimate more tokens", () => {
    const small = estimateIngest("x".repeat(5000), "openai");
    const large = estimateIngest("x".repeat(50000), "openai");
    expect(large.totalTokens).toBeGreaterThan(small.totalTokens);
  });

  test("empty text yields a zero-cost estimate", () => {
    const est = estimateIngest("", "gemini");
    expect(est.sizeChars).toBe(0);
    expect(est.estimatedCostUsd).toBe(0);
  });
});
