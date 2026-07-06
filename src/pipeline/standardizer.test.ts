import { expect, test, describe } from "bun:test";
import { compileTerms, standardizeTerms } from "./standardizer";

// Characterization tests: lock in the current term-standardization behaviour
// (case-insensitive, word-boundary aware, skips markdown links).

describe("compileTerms", () => {
  test("compiles one CompiledTerm per mapping entry", () => {
    const compiled = compileTerms({ ML: "Machine Learning", DL: "Deep Learning" });
    expect(compiled).toHaveLength(2);
    expect(compiled[0].replacement).toBe("Machine Learning");
    expect(compiled[0].regex).toBeInstanceOf(RegExp);
  });

  test("empty mapping produces empty array", () => {
    expect(compileTerms({})).toHaveLength(0);
  });
});

describe("standardizeTerms", () => {
  const terms = compileTerms({ ML: "Machine Learning", "e.g.": "for example" });

  test("replaces a standalone abbreviation", () => {
    expect(standardizeTerms("I love ML.", terms)).toBe("I love Machine Learning.");
  });

  test("is case-insensitive", () => {
    expect(standardizeTerms("study of ml basics", terms)).toBe(
      "study of Machine Learning basics",
    );
  });

  test("replaces every occurrence (global)", () => {
    expect(standardizeTerms("ML and more ML", terms)).toBe(
      "Machine Learning and more Machine Learning",
    );
  });

  test("respects word boundaries (does not touch HTML)", () => {
    expect(standardizeTerms("the HTML spec", terms)).toBe("the HTML spec");
  });

  test("does not rewrite a bare markdown link label", () => {
    const input = "see [ML] reference";
    expect(standardizeTerms(input, terms)).toBe(input);
  });

  test("escapes regex special chars without throwing; \\b prevents matching a trailing-dot term", () => {
    // Characterization: "e.g." is compiled without error, but the trailing "."
    // means the \b word-boundary anchor never matches, so it is left as-is.
    expect(standardizeTerms("as noted e.g. here", terms)).toBe("as noted e.g. here");
  });

  test("returns content unchanged when no terms match", () => {
    expect(standardizeTerms("nothing to replace", terms)).toBe("nothing to replace");
  });

  test("empty compiled-terms list is a no-op", () => {
    expect(standardizeTerms("ML stays", [])).toBe("ML stays");
  });
});
