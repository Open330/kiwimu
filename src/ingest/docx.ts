export async function extractTextFromDocx(filePath: string): Promise<{ title: string; text: string }> {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  const text: string = result.value;
  const title = filePath.split("/").pop()?.replace(/\.docx?$/i, "") || "Untitled";
  return { title, text };
}

export async function extractHtmlFromDocx(filePath: string): Promise<{ title: string; html: string }> {
  const mammoth = require("mammoth");
  const result = await mammoth.convertToHtml({ path: filePath });
  const html: string = result.value;
  const title = filePath.split("/").pop()?.replace(/\.docx?$/i, "") || "Untitled";
  return { title, html };
}
