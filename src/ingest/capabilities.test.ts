import { describe, expect, test } from "bun:test";
import {
  detectServerUploadCapabilities,
  normalizeUploadExtension,
  unsupportedServerUploadMessage,
} from "./capabilities";

describe("server upload capabilities", () => {
  test("advertises only built-in formats when legacy extractor commands are absent", () => {
    const capabilities = detectServerUploadCapabilities(() => false);

    expect(capabilities.supportedExtensions).toEqual(["pdf", "docx", "pptx", "md"]);
    expect(capabilities.missingCommandByExtension).toEqual({
      doc: "textutil",
      ppt: "strings",
      key: "strings",
      rtf: "textutil",
    });
  });

  test("enables each legacy family only when its actual extractor is available", () => {
    expect(detectServerUploadCapabilities(command => command === "textutil").supportedExtensions)
      .toEqual(["pdf", "docx", "pptx", "doc", "rtf", "md"]);
    expect(detectServerUploadCapabilities(command => command === "strings").supportedExtensions)
      .toEqual(["pdf", "docx", "pptx", "ppt", "key", "md"]);
  });

  test("normalizes the preflight header and explains missing runtime commands", () => {
    const capabilities = detectServerUploadCapabilities(() => false);

    expect(normalizeUploadExtension(" .RTF ")).toBe("rtf");
    expect(normalizeUploadExtension("../rtf")).toBeNull();
    expect(unsupportedServerUploadMessage("rtf", capabilities)).toContain("textutil 추출 명령이 필요합니다");
  });
});
