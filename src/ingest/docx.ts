export async function extractTextFromDocx(filePath: string): Promise<{ title: string; text: string }> {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  const text: string = result.value;
  const title = filePath.split("/").pop()?.replace(/\.docx?$/i, "") || "Untitled";
  return { title, text };
}
