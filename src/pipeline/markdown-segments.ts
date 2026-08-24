export interface MarkdownSegment {
  text: string;
  protected: boolean;
  start: number;
  end: number;
}

interface MarkdownRange {
  start: number;
  end: number;
}

export interface WikiLinkMarker {
  raw: string;
  slug: string;
  display?: string;
}

const MARKDOWN_LINK = /!?\[[^\]\r\n]*\]\([^\)\r\n]+\)/g;
const HTML_LINK_OR_CODE = /<(a|code|pre)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BARE_URL = /https?:\/\/[^\s<>)]+/gi;
const WIKI_LINK_MARKER = /\[\[([^\]|\r\n]+?)(?:\|([^\]\r\n]+?))?\]\]/g;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeRanges(ranges: MarkdownRange[]): MarkdownRange[] {
  if (ranges.length === 0) return [];
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MarkdownRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else if (range.end > previous.end) {
      previous.end = range.end;
    }
  }
  return merged;
}

function fencedCodeRanges(markdown: string): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  const openerPattern = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm;
  let opener: RegExpExecArray | null;

  while ((opener = openerPattern.exec(markdown)) !== null) {
    const marker = opener[1];
    const markerChar = marker[0];
    // CommonMark does not allow a backtick in a backtick fence's info string.
    const openerLine = opener[0].replace(/\r?\n$/, "");
    const markerOffset = openerLine.indexOf(marker);
    if (markerChar === "`" && openerLine.slice(markerOffset + marker.length).includes("`")) continue;

    const closingPattern = new RegExp(
      `^ {0,3}${escapeRegex(markerChar)}{${marker.length},}[ \\t]*(?:\\r?$)`,
      "gm",
    );
    closingPattern.lastIndex = openerPattern.lastIndex;
    const closing = closingPattern.exec(markdown);
    let end = markdown.length;
    if (closing) {
      end = closing.index + closing[0].length;
      if (markdown[end] === "\r" && markdown[end + 1] === "\n") end += 2;
      else if (markdown[end] === "\n") end += 1;
    }
    ranges.push({ start: opener.index, end });
    openerPattern.lastIndex = end;
  }

  return ranges;
}

function forEachGap(
  markdown: string,
  protectedRanges: MarkdownRange[],
  visitor: (text: string, offset: number) => void,
): void {
  let cursor = 0;
  for (const range of protectedRanges) {
    if (cursor < range.start) visitor(markdown.slice(cursor, range.start), cursor);
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < markdown.length) visitor(markdown.slice(cursor), cursor);
}

function inlineCodeRanges(markdown: string, fencedRanges: MarkdownRange[]): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  forEachGap(markdown, fencedRanges, (gap, offset) => {
    const runs = /`+/g;
    let opening: RegExpExecArray | null;
    while ((opening = runs.exec(gap)) !== null) {
      const width = opening[0].length;
      let closing: RegExpExecArray | null;
      while ((closing = runs.exec(gap)) !== null && closing[0].length !== width) {
        // A code span closes only with a run of the same width.
      }
      if (!closing) break;
      ranges.push({
        start: offset + opening.index,
        end: offset + closing.index + closing[0].length,
      });
    }
  });
  return ranges;
}

function regexRanges(
  markdown: string,
  protectedRanges: MarkdownRange[],
  pattern: RegExp,
): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  forEachGap(markdown, protectedRanges, (gap, offset) => {
    pattern.lastIndex = 0;
    for (const match of gap.matchAll(pattern)) {
      ranges.push({ start: offset + match.index, end: offset + match.index + match[0].length });
    }
  });
  return ranges;
}

/**
 * Split Markdown into ordinary text and ranges whose code/navigation semantics
 * must be preserved byte-for-byte by later content transforms.
 */
export function splitProtectedMarkdown(markdown: string): MarkdownSegment[] {
  if (!markdown) return [];

  const fences = mergeRanges(fencedCodeRanges(markdown));
  const code = mergeRanges([...fences, ...inlineCodeRanges(markdown, fences)]);
  const protectedRanges = mergeRanges([
    ...code,
    ...regexRanges(markdown, code, MARKDOWN_LINK),
    ...regexRanges(markdown, code, HTML_LINK_OR_CODE),
    ...regexRanges(markdown, code, BARE_URL),
  ]);

  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  for (const range of protectedRanges) {
    if (cursor < range.start) {
      segments.push({ text: markdown.slice(cursor, range.start), protected: false, start: cursor, end: range.start });
    }
    segments.push({
      text: markdown.slice(range.start, range.end),
      protected: true,
      start: range.start,
      end: range.end,
    });
    cursor = range.end;
  }
  if (cursor < markdown.length) {
    segments.push({ text: markdown.slice(cursor), protected: false, start: cursor, end: markdown.length });
  }
  return segments;
}

export function transformUnprotectedMarkdown(
  markdown: string,
  transform: (text: string, start: number) => string,
): string {
  return splitProtectedMarkdown(markdown)
    .map((segment) => segment.protected ? segment.text : transform(segment.text, segment.start))
    .join("");
}

/** Apply the shared `[[slug|display]]` grammar outside protected Markdown. */
export function replaceWikiLinkMarkers(
  markdown: string,
  replace: (marker: WikiLinkMarker) => string,
): string {
  return transformUnprotectedMarkdown(markdown, (text) => {
    WIKI_LINK_MARKER.lastIndex = 0;
    return text.replace(WIKI_LINK_MARKER, (raw, rawSlug: string, rawDisplay?: string) => {
      const slug = rawSlug.trim();
      const display = rawDisplay?.trim();
      if (!slug || (rawDisplay !== undefined && !display)) return raw;
      return replace({ raw, slug, display });
    });
  });
}
