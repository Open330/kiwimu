import { readFileSync } from "fs";

export async function extractTextFromPptx(filePath: string): Promise<{ title: string; text: string }> {
  // PPTX is a ZIP containing XML files
  const { Decompress } = await import("bun");
  const JSZip = (await import("jszip")).default;

  const buffer = readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const slides: string[] = [];

  // Parse each slide XML
  const slideFiles = Object.keys(zip.files)
    .filter((f) => f.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0");
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0");
      return numA - numB;
    });

  for (const slidePath of slideFiles) {
    const xml = await zip.files[slidePath].async("text");
    // Extract text from <a:t> tags
    const texts: string[] = [];
    const regex = /<a:t>([^<]*)<\/a:t>/g;
    let match;
    while ((match = regex.exec(xml))) {
      if (match[1].trim()) texts.push(match[1]);
    }
    if (texts.length) {
      slides.push(texts.join(" "));
    }
  }

  const title = filePath.split("/").pop()?.replace(/\.pptx?$/i, "") || "Untitled";
  const text = slides.map((s, i) => `Slide ${i + 1}:\n${s}`).join("\n\n");
  return { title, text };
}
