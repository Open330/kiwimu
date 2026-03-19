export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s가-힣ㄱ-ㅎㅏ-ㅣ-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export function cleanTitle(title: string): string {
  return title
    .replace(/^\s*(Chapter\s+)?\d+(\.\d+)*\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
