import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import JSZip from "jszip";
import { extractTextFromDocx } from "./docx";
import { extractWithTextutil } from "./legacy";
import { IngestResourceLimitError, MAX_SOURCE_FILE_BYTES } from "./limits";
import { extractTextFromPdf } from "./pdf";
import {
  assertPptxSlideLimits,
  extractTextFromPptx,
  MAX_PPTX_SLIDE_XML_BYTES,
} from "./pptx";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kiwimu-parser-test-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function buildMinimalPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function writeZip(path: string, entries: Record<string, string>): Promise<void> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value, { createFolders: false });
  const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  writeFileSync(path, archive);
}

async function writeMinimalDocx(path: string): Promise<void> {
  await writeZip(path, {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>',
  });
}

describe("bounded document parsers", () => {
  test("extracts a minimal PDF and rejects oversized input before parsing", async () => {
    const root = temporaryRoot();
    const pdfPath = join(root, "minimal.pdf");
    writeFileSync(pdfPath, buildMinimalPdf("Hello PDF"));
    const result = await extractTextFromPdf(pdfPath);
    expect(result.title).toBe("minimal");
    expect(result.text).toContain("Hello PDF");

    const oversized = join(root, "oversized.pdf");
    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_SOURCE_FILE_BYTES + 1);
    await expect(extractTextFromPdf(oversized)).rejects.toBeInstanceOf(IngestResourceLimitError);
  });

  test("checks PDF cancellation before entering its non-preemptible parser", async () => {
    const root = temporaryRoot();
    const pdfPath = join(root, "cancelled.pdf");
    writeFileSync(pdfPath, buildMinimalPdf("Should not parse"));
    const reason = new Error("shutdown interrupted PDF parse");
    const controller = new AbortController();
    controller.abort(reason);

    await expect(extractTextFromPdf(pdfPath, controller.signal)).rejects.toBe(reason);
  });

  test("preflights and extracts a minimal DOCX from the inspected buffer", async () => {
    const path = join(temporaryRoot(), "minimal.docx");
    await writeMinimalDocx(path);
    const result = await extractTextFromDocx(path);
    expect(result).toMatchObject({ title: "minimal" });
    expect(result.text).toContain("Hello DOCX");
  });

  test("extracts ordered PPTX slides and rejects oversized slide XML before inflation", async () => {
    const root = temporaryRoot();
    const path = join(root, "minimal.pptx");
    await writeZip(path, {
      "ppt/slides/slide2.xml": "<p:sld><a:t>Second</a:t></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:t>First</a:t></p:sld>",
    });
    const result = await extractTextFromPptx(path);
    expect(result.title).toBe("minimal");
    expect(result.text).toBe("Slide 1:\nFirst\n\nSlide 2:\nSecond");

    const oversized = join(root, "oversized.pptx");
    await writeZip(oversized, {
      "ppt/slides/slide1.xml": `<p:sld><a:t>${"x".repeat(MAX_PPTX_SLIDE_XML_BYTES)}</a:t></p:sld>`,
    });
    await expect(extractTextFromPptx(oversized)).rejects.toThrow("slide1.xml");
  }, 15_000);

  test("bounds PPTX slide count and aggregate declared XML before inflation", () => {
    const entries = [
      { name: "ppt/slides/slide1.xml", uncompressedBytes: 6 },
      { name: "ppt/slides/slide2.xml", uncompressedBytes: 6 },
    ];
    expect(() => assertPptxSlideLimits(entries, {
      maxSlides: 1,
      maxSlideXmlBytes: 10,
      maxTotalSlideXmlBytes: 20,
    })).toThrow("slide limit");
    expect(() => assertPptxSlideLimits(entries, {
      maxSlides: 2,
      maxSlideXmlBytes: 10,
      maxTotalSlideXmlBytes: 11,
    })).toThrow("aggregate limit");
  });

  test("legacy extraction uses a bounded runner and checks non-zero exits", async () => {
    const path = join(temporaryRoot(), "legacy.doc");
    writeFileSync(path, "fixture");
    const commands: string[][] = [];
    const result = await extractWithTextutil(path, async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "Legacy text", stderr: "" };
    });
    expect(result).toEqual({ title: basename(path, ".doc"), text: "Legacy text" });
    expect(commands).toEqual([["textutil", "-convert", "txt", "-stdout", "--", path]]);

    await expect(extractWithTextutil(path, async () => ({
      exitCode: 2,
      stdout: "",
      stderr: "conversion failed",
    }))).rejects.toThrow("conversion failed");
  });
});
