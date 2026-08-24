export function slugify(text: string): string {
  const normalized = text
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^-|-$/g, "");

  return Array.from(normalized).slice(0, 80).join("").replace(/-+$/g, "");
}

export function cleanTitle(title: string): string {
  return title
    .replace(/^\s*(Chapter\s+)?\d+(\.\d+)*\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
