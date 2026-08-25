import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Store } from "../store";
import { lintWiki } from "./lint";

// Characterization tests for content-level dead-link detection and the
// schema-driven thin-content threshold. All state lives in an in-memory Store.
describe("lintWiki", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
    store.initSchema();
  });

  afterEach(() => {
    store.close();
  });

  const deadLinks = (schema?: Parameters<typeof lintWiki>[1]) =>
    lintWiki(store, schema).issues.filter((i) => i.type === "dead_link");

  test("content `[[Nonexistent]]` marker yields a dead_link issue", () => {
    const page = store.addPage(
      "quantum",
      "양자역학",
      "본문에서 [[Nonexistent]] 개념을 참조하지만 그런 페이지는 없습니다.",
    );

    const issues = deadLinks();
    expect(issues.length).toBe(1);
    expect(issues[0].pageId).toBe(page.id);
    expect(issues[0].pageTitle).toBe("양자역학");
    // slugify("Nonexistent") === "nonexistent"
    expect(issues[0].message).toContain("nonexistent");
  });

  test("inline `](/wiki/<slug>)` target to a missing page yields a dead_link", () => {
    store.addPage("home", "홈", "자세한 내용은 [여기](/wiki/missing-page)를 참조하세요.");

    const issues = deadLinks();
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain("missing-page");
  });

  test("a `[[X]]` marker resolving to an existing page is NOT flagged", () => {
    store.addPage("파동함수", "파동함수", "파동함수는 양자 상태를 기술합니다. ".repeat(6));
    store.addPage(
      "슈뢰딩거-방정식",
      "슈뢰딩거 방정식",
      "슈뢰딩거 방정식은 [[파동함수]]의 시간 변화를 기술합니다. ".repeat(4),
    );

    expect(deadLinks().length).toBe(0);
  });

  test("duplicate dangling references to the same target are deduped", () => {
    store.addPage(
      "src",
      "출처",
      "[[Nonexistent]] 그리고 다시 [[Nonexistent]] 및 [링크](/wiki/nonexistent) 참조.",
    );

    const issues = deadLinks();
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain("nonexistent");
  });

  test("thin_content threshold falls back to 100 chars when schema is unset", () => {
    // ~60 chars: thin under the default, comfortably below 100.
    store.addPage("short", "짧은 글", "너무 짧은 문서입니다. ".repeat(5));

    const thin = lintWiki(store).issues.filter((i) => i.type === "thin_content");
    expect(thin.some((i) => i.pageTitle === "짧은 글")).toBe(true);
  });

  test("thin_content respects schema.min_page_length", () => {
    // ~150 chars: above the default 100, below a configured 300.
    const body = "적당한 길이의 문서입니다. ".repeat(12);
    store.addPage("medium", "중간 글", body);
    expect(body.length).toBeGreaterThan(100);
    expect(body.length).toBeLessThan(300);

    const withoutSchema = lintWiki(store).issues.filter(
      (i) => i.type === "thin_content" && i.pageTitle === "중간 글",
    );
    expect(withoutSchema.length).toBe(0);

    const withSchema = lintWiki(store, { min_page_length: 300 }).issues.filter(
      (i) => i.type === "thin_content" && i.pageTitle === "중간 글",
    );
    expect(withSchema.length).toBe(1);
    expect(withSchema[0].message).toContain("minimum 300");
  });
});
