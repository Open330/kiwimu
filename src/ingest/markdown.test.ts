import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTextFromMarkdown } from "./markdown";

const temporaryDirectories: string[] = [];

function extract(content: string, filename = "notes.md") {
  const root = mkdtempSync(join(tmpdir(), "kiwimu-markdown-"));
  temporaryDirectories.push(root);
  const path = join(root, filename);
  writeFileSync(path, content);
  return extractTextFromMarkdown(path);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("extractTextFromMarkdown", () => {
  test("removes a closed YAML mapping frontmatter block", () => {
    const result = extract("---\ntitle: Frontmatter title\ntags:\n  - study\n---\n# Document title\n\nBody");

    expect(result.title).toBe("Document title");
    expect(result.text).toBe("# Document title\n\nBody");
  });

  test("preserves an opening horizontal rule when the following block is prose", () => {
    const content = "---\nThis is ordinary prose, not YAML metadata.\n---\n# Actual title\n\nBody";

    const result = extract(content);

    expect(result.title).toBe("Actual title");
    expect(result.text).toBe(content);
  });

  test("does not mistake a URL between horizontal rules for a YAML mapping", () => {
    const content = "---\nhttps://example.com/notes\n---\n# Actual title";

    expect(extract(content).text).toBe(content);
  });

  test("recognizes Unicode YAML keys", () => {
    const content = "---\n제목: 학습 노트\n---\n# Actual title";

    expect(extract(content).text).toBe("# Actual title");
  });

  test("preserves an unclosed frontmatter-looking prefix", () => {
    const content = "---\ntitle: Still content\n# Heading\n\nBody";

    expect(extract(content).text).toBe(content);
  });

  test("requires the closing delimiter to occupy its own line", () => {
    const content = "---\ntitle: Still content\ntext --- inline\n# Heading";

    expect(extract(content).text).toBe(content);
  });
});
