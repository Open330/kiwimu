import { readFileSync } from "fs";
import { basename } from "path";
import { throwIfAborted } from "../abort";

function stripPlausibleFrontmatter(content: string): string {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!match) return content;

  // A horizontal rule followed later by another rule is ordinary Markdown.
  // Treat the leading block as frontmatter only when it contains at least one
  // conventional YAML mapping key.
  const body = match[1];
  if (!/^[\p{L}_][\p{L}\p{N}_-]*[ \t]*:(?:[ \t]+.*|[ \t]*)$/mu.test(body)) return content;

  return content.slice(match[0].length).trim();
}

export function extractTextFromMarkdown(filePath: string, signal?: AbortSignal): { title: string; text: string } {
  throwIfAborted(signal);
  const content = readFileSync(filePath, "utf-8");
  throwIfAborted(signal);

  const text = stripPlausibleFrontmatter(content);

  // Extract title from first # heading
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : basename(filePath, ".md");

  return { title, text };
}
