import type { Section } from "./web";

export async function extractFromPdf(pdfPath: string): Promise<{ title: string; sections: Section[] }> {
  // Dynamic import - pdf-parse is optional
  let pdfParse: any;
  try {
    pdfParse = (await import("pdf-parse")).default;
  } catch {
    throw new Error("PDF support requires pdf-parse. Run: bun add pdf-parse");
  }

  const buffer = await Bun.file(pdfPath).arrayBuffer();
  const data = await pdfParse(Buffer.from(buffer));

  const title = data.info?.Title || pdfPath.split("/").pop()?.replace(".pdf", "") || "Untitled";
  const lines = data.text.split("\n");

  const sections: Section[] = [];
  let current: Section = { level: 1, title: "Introduction", htmlParts: [] };
  let currentParagraph: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      current.htmlParts.push(`<p>${currentParagraph.join(" ")}</p>`);
      currentParagraph = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    // Heuristic: short lines in ALL CAPS or with numbering = heading
    const isHeading =
      (trimmed.length < 100 && trimmed === trimmed.toUpperCase() && trimmed.length > 3) ||
      /^\d+(\.\d+)*\s+[A-Z]/.test(trimmed);

    if (isHeading) {
      flushParagraph();
      if (current.htmlParts.length > 0) {
        sections.push(current);
      }
      const level = (trimmed.match(/\./g) || []).length + 1;
      current = { level: Math.min(level, 3), title: trimmed, htmlParts: [] };
    } else {
      currentParagraph.push(trimmed);
    }
  }

  flushParagraph();
  if (current.htmlParts.length > 0) {
    sections.push(current);
  }

  return { title, sections };
}
