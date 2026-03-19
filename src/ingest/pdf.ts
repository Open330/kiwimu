export async function extractTextFromPdf(pdfPath: string): Promise<{ title: string; text: string }> {
  let pdfParse: (buffer: Buffer) => Promise<{ info?: { Title?: string }; text: string }>;
  try {
    pdfParse = require("pdf-parse");
  } catch {
    throw new Error("PDF support requires pdf-parse. Run: bun add pdf-parse");
  }

  const buffer = await Bun.file(pdfPath).arrayBuffer();
  const data = await pdfParse(Buffer.from(buffer));

  const title = data.info?.Title || pdfPath.split("/").pop()?.replace(".pdf", "") || "Untitled";
  return { title, text: data.text };
}
