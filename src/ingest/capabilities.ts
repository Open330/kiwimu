import { SUPPORTED_EXTENSIONS } from "../config";

export const UPLOAD_EXTENSION_HEADER = "X-Kiwimu-File-Extension";

const BUILTIN_SERVER_EXTENSIONS = new Set(["pdf", "docx", "pptx", "md"]);
const LEGACY_EXTRACTOR_COMMANDS: Readonly<Record<string, string>> = {
  doc: "textutil",
  rtf: "textutil",
  ppt: "strings",
  key: "strings",
};

export interface ServerUploadCapabilities {
  supportedExtensions: readonly string[];
  missingCommandByExtension: Readonly<Record<string, string>>;
}

type CommandAvailable = (command: string) => boolean;

/**
 * Detect only capabilities the current server process can actually execute.
 * CLI support remains broader: this helper is used only by live upload routes.
 */
export function detectServerUploadCapabilities(
  commandAvailable: CommandAvailable = (command) => Bun.which(command) !== null,
): ServerUploadCapabilities {
  const supportedExtensions: string[] = [];
  const missingCommandByExtension: Record<string, string> = {};

  for (const extension of SUPPORTED_EXTENSIONS) {
    if (BUILTIN_SERVER_EXTENSIONS.has(extension)) {
      supportedExtensions.push(extension);
      continue;
    }

    const command = LEGACY_EXTRACTOR_COMMANDS[extension];
    if (command && commandAvailable(command)) supportedExtensions.push(extension);
    else if (command) missingCommandByExtension[extension] = command;
  }

  return { supportedExtensions, missingCommandByExtension };
}

export function normalizeUploadExtension(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]+$/.test(normalized) ? normalized : null;
}

export function unsupportedServerUploadMessage(
  extension: string,
  capabilities: ServerUploadCapabilities,
): string {
  const command = capabilities.missingCommandByExtension[extension];
  if (command) {
    return `.${extension} 파일은 이 서버 런타임에서 지원되지 않습니다. ${command} 추출 명령이 필요합니다. ` +
      `현재 지원: ${capabilities.supportedExtensions.join(", ")}`;
  }
  return `지원하지 않는 형식: .${extension}. 현재 지원: ${capabilities.supportedExtensions.join(", ")}`;
}
