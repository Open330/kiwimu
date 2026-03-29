import { readFileSync } from "fs";
import { basename } from "path";

export function extractTextFromMarkdown(filePath: string): { title: string; text: string } {
  const content = readFileSync(filePath, "utf-8");

  // Remove YAML frontmatter if present
  let text = content;
  if (text.startsWith("---")) {
    const endIndex = text.indexOf("---", 3);
    if (endIndex !== -1) {
      text = text.slice(endIndex + 3).trim();
    }
  }

  // Extract title from first # heading
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : basename(filePath, ".md");

  return { title, text };
}
