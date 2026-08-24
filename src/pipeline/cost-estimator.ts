/**
 * Pre-ingest token & cost estimation.
 *
 * These are heuristics used to show the user an approximate token/cost preview
 * BEFORE spending real LLM calls. They intentionally over-estimate slightly so
 * the confirmation prompt never surprises the user with a higher-than-shown bill.
 */
import { estimateCostUsd } from "../llm-client";

/** Rough token count for a text blob (~4 chars/token, English/Korean mix). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Number of chapter/size chunks Phase 1 will produce (mirrors llm-chunker split). */
export function estimateChunkCount(text: string, chunkChars = 20000): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / chunkChars));
}

export interface IngestEstimate {
  sizeChars: number;
  chunks: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Null means this custom provider/model has no verified standard price. */
  estimatedCostUsd: number | null;
}

export function formatEstimatedCost(cost: number | null): string {
  return cost === null ? "가격 정보 없음" : `~$${cost.toFixed(4)}`;
}

/**
 * Estimate total tokens/cost for a full ingest of `text` with a given provider.
 *
 * The pipeline makes calls in several phases:
 *  - Phase 1 (structure): 1 call per chunk, prompt ≈ chunk text, output ≈ chunk text
 *  - Phase 2 (concepts):  1 call per batch of source pages, moderate prompt/output
 *  - Phase 2.5 (quizzes): small calls per concept page
 * We approximate this as a multiple of the raw document token count.
 */
export function estimateIngest(text: string, provider: string, model: string): IngestEstimate {
  const sizeChars = text?.length ?? 0;
  const chunks = estimateChunkCount(text);
  const baseTokens = estimateTokens(text);

  // Phase 1: send the doc once (as chunks) + system overhead per chunk, receive
  // a cleaned-up markdown version of comparable length.
  const phase1Prompt = baseTokens + chunks * 300;
  const phase1Completion = Math.round(baseTokens * 0.9);

  // Phase 2 + 2.5: concept extraction + quizzes work over summaries/pages, roughly
  // half the document again on input and a third on output.
  const phase2Prompt = Math.round(baseTokens * 0.5) + chunks * 200;
  const phase2Completion = Math.round(baseTokens * 0.35);

  const promptTokens = phase1Prompt + phase2Prompt;
  const completionTokens = phase1Completion + phase2Completion;
  const totalTokens = promptTokens + completionTokens;
  const estimatedCostUsd = estimateCostUsd(provider, model, promptTokens, completionTokens);

  return { sizeChars, chunks, promptTokens, completionTokens, totalTokens, estimatedCostUsd };
}
