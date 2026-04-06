/**
 * Term standardization post-processor.
 * Replaces abbreviations/variants with their standard forms,
 * using case-insensitive word-boundary matching.
 */

interface CompiledTerm {
  regex: RegExp;
  replacement: string;
}

/**
 * Compile term mappings into reusable RegExp objects.
 * Call once, reuse the result for multiple standardizeTerms calls.
 */
export function compileTerms(terms: Record<string, string>): CompiledTerm[] {
  const compiled: CompiledTerm[] = [];
  for (const [abbrev, standard] of Object.entries(terms)) {
    // Escape special regex chars in the abbreviation
    const escaped = abbrev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word-boundary aware, case-insensitive
    // Negative lookbehind/lookahead to avoid matching inside markdown links
    compiled.push({
      regex: new RegExp(`(?<!\\[)\\b(${escaped})\\b(?!\\])(?![^[]*\\])`, "gi"),
      replacement: standard,
    });
  }
  return compiled;
}

/**
 * Apply term standardization to content.
 * Replaces abbreviations with standard terms using pre-compiled regexes.
 */
export function standardizeTerms(content: string, compiledTerms: CompiledTerm[]): string {
  let result = content;
  for (const { regex, replacement } of compiledTerms) {
    result = result.replace(regex, replacement);
  }
  return result;
}
