/**
 * Shared utility functions used across the codebase.
 */

/** Escape HTML special characters to prevent XSS in template output. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip markdown JSON code fences that LLMs often wrap around JSON output. */
export function stripJsonFences(raw: string): string {
  return raw.replace(/^```json?\n?/m, "").replace(/\n?```\s*$/m, "").trim();
}

/**
 * Normalize a title for comparison: lowercase, strip punctuation (keep
 * alphanumeric, Korean characters, and spaces), collapse whitespace.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s가-힣ㄱ-ㅎㅏ-ㅣ]/g, "")
    .replace(/\s+/g, " ");
}
