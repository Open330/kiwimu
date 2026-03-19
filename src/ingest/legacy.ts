/**
 * Extract text from legacy formats (DOC, PPT, KEY) using macOS textutil/CLI tools.
 */
export async function extractWithTextutil(filePath: string): Promise<{ title: string; text: string }> {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const title = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") || "Untitled";

  // textutil supports: doc, docx, rtf, rtfd, html, webarchive, odt, wordml
  const textutilFormats = new Set(["doc", "rtf", "odt"]);

  if (textutilFormats.has(ext)) {
    const proc = Bun.spawn(["textutil", "-convert", "txt", "-stdout", "--", filePath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`textutil failed: ${stderr}`);
    }
    return { title, text };
  }

  // For .key (Keynote), try mdimport for metadata or strings extraction
  if (ext === "key") {
    // Try to extract text using mdimport/spotlight metadata
    try {
      const proc = Bun.spawn(["mdimport", "-d2", "--", filePath], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    } catch {}

    // Keynote files are directories or zip-like packages. Try strings extraction.
    const proc = Bun.spawn(["strings", "--", filePath], { stdout: "pipe", stderr: "pipe" });
    const raw = await new Response(proc.stdout).text();
    await proc.exited;

    // Filter to lines that look like actual text content
    const lines = raw.split("\n").filter((l) => {
      const t = l.trim();
      return t.length > 10 && /[a-zA-Z가-힣]/.test(t) && !/^[{<\[]/.test(t);
    });

    if (!lines.length) {
      throw new Error("Keynote 파일에서 텍스트를 추출할 수 없습니다. PDF로 내보내기 후 다시 시도해주세요.");
    }

    return { title, text: lines.join("\n") };
  }

  // For .ppt (legacy PowerPoint), try textutil or strings
  if (ext === "ppt") {
    const proc = Bun.spawn(["strings", "--", filePath], { stdout: "pipe", stderr: "pipe" });
    const raw = await new Response(proc.stdout).text();
    await proc.exited;

    const lines = raw.split("\n").filter((l) => {
      const t = l.trim();
      return t.length > 5 && /[a-zA-Z가-힣]/.test(t) && !/^[{<\[\x00-\x1f]/.test(t);
    });

    return { title, text: lines.join("\n") };
  }

  throw new Error(`지원하지 않는 파일 형식: .${ext}`);
}
