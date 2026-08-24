import { parse, stringify } from "smol-toml";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";

export const CONFIG_FILE = "kiwi.toml";
export const DB_FILE = "kiwi.db";
export const SITE_DIR = "_site";
export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'pptx', 'doc', 'ppt', 'key', 'rtf', 'md'];
export const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";
// Keep the retired identifier assembled so it cannot accidentally reappear in
// user-facing defaults or documentation while exact legacy configs still load.
const RETIRED_GEMINI_DEFAULT = ["gemini-3.1-flash-lite", "preview"].join("-");

export interface LLMConfig {
  provider: string; // "gemini" | "azure-openai" | "openai" | "anthropic"
  model: string;
  api_key: string;
  endpoint: string; // for Azure OpenAI
}

export interface Persona {
  name: string;
  description: string;
  system_prompt: string;
  content_style: string; // injected into content generation prompts
}

export interface EmbeddingConfig {
  provider: string; // "gemini" | "openai" | "azure-openai"
  api_key: string;
}

export interface QAConfig {
  auto_promote: boolean; // If true, automatically save all Q&A answers as wiki pages
}

export interface WikiSchema {
  categories?: string[];
  naming_convention?: 'noun_phrase' | 'question' | 'topic';
  min_page_length?: number;
  max_page_length?: number;
  terms?: Record<string, string>;
  page_template?: { sections?: string[] };
}

/** A user-defined source category for sidebar/index grouping. */
export interface SourceCategory {
  /** Display label, e.g. "📋 PRD". Korean/emoji OK. */
  name: string;
  /** Display order; lower numbers appear first. */
  order: number;
  /**
   * Glob-like patterns matched against the source URI (case-insensitive).
   * Supports `*` as a wildcard. Patterns are tested against the basename
   * (filename) and the full URI; matching either counts.
   * Examples: "F[0-9][0-9]_*", "weekly/*", "STUDY_PLAN*"
   */
  patterns: string[];
}

export interface KiwiConfig {
  project: { name: string; created: string };
  build: {
    output_dir: string;
    /** Absolute site URL (origin + optional base path) for sitemap/canonical/OG tags. */
    site_url?: string;
    /** `<html lang>` value for generated pages. Defaults to "ko". */
    lang?: string;
  };
  llm: LLMConfig;
  embedding?: EmbeddingConfig; // separate config for embeddings (optional, falls back to llm)
  qa?: QAConfig; // Q&A feedback loop settings
  deploy: { target: string };
  personas?: Persona[];
  active_persona?: string; // name of the active persona
  schema?: WikiSchema;
  categories?: SourceCategory[]; // optional source categorization for grouped rendering
}

/** Directory containing built-in persona JSON files (shipped with the package) */
function getPersonasDir(): string {
  // Works both in dev (src/) and built (dist/) — personas/ is at project root
  return join(dirname(__dirname), "personas");
}

/** Load a single persona from a JSON file */
function loadPersonaFile(filePath: string): Persona {
  return JSON.parse(readFileSync(filePath, "utf-8")) as Persona;
}

/** Load all built-in personas from the personas/ directory */
export function loadBuiltinPersonas(): Persona[] {
  const dir = getPersonasDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => loadPersonaFile(join(dir, f)));
}

/** Get the default persona (first built-in, or fallback) */
export function getDefaultPersona(): Persona {
  const builtins = loadBuiltinPersonas();
  if (builtins.length > 0) return builtins[0];
  // Minimal fallback if no persona files exist
  return { name: "default", description: "Default wiki style", system_prompt: "", content_style: "" };
}

export function defaultConfig(name: string): KiwiConfig {
  const builtins = loadBuiltinPersonas();
  return {
    project: { name, created: new Date().toISOString().slice(0, 10) },
    build: { output_dir: SITE_DIR },
    llm: { provider: "gemini", model: DEFAULT_GEMINI_MODEL, api_key: "", endpoint: "" },
    deploy: { target: "gh-pages" },
    personas: builtins.length > 0 ? builtins : [getDefaultPersona()],
    active_persona: builtins[0]?.name || "default",
  };
}

export function getActivePersona(config: KiwiConfig): Persona | null {
  if (!config.active_persona || !config.personas?.length) return null;
  return config.personas.find(p => p.name === config.active_persona) ?? null;
}

export function saveConfig(root: string, config: KiwiConfig): void {
  const target = join(root, CONFIG_FILE);
  const temporary = join(root, `.${CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = stringify(config);
  let descriptor: number | null = null;
  let directoryDescriptor: number | null = null;

  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
    directoryDescriptor = openSync(dirname(target), "r");
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    directoryDescriptor = null;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (directoryDescriptor !== null) {
      try {
        closeSync(directoryDescriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], `Failed to save ${CONFIG_FILE} and clean up its temporary file`);
    }
    throw error;
  }
}

export function loadConfig(root: string): KiwiConfig {
  const content = readFileSync(join(root, CONFIG_FILE), "utf-8");
  const raw = parse(content) as Partial<KiwiConfig> & Record<string, unknown>;
  // Migrate old config format
  if (!raw.llm) {
    raw.llm = { provider: "gemini", model: DEFAULT_GEMINI_MODEL, api_key: "", endpoint: "" };
  } else if (raw.llm.provider === "gemini" && raw.llm.model === RETIRED_GEMINI_DEFAULT) {
    // The preview endpoint was shut down. Migrate only Kiwi Mu's exact retired
    // default; user-selected model identifiers remain untouched.
    raw.llm.model = DEFAULT_GEMINI_MODEL;
  }
  // Migrate: add default persona if missing
  if (!raw.personas || !raw.personas.length) {
    const builtins = loadBuiltinPersonas();
    raw.personas = builtins.length > 0 ? builtins : [getDefaultPersona()];
    raw.active_persona = raw.personas[0]?.name || "default";
  }
  if (!raw.active_persona) {
    raw.active_persona = raw.personas[0]?.name || "default";
  }
  return raw as KiwiConfig;
}

export function findProjectRoot(from: string = process.cwd()): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("No kiwi.toml found. Run 'kiwimu init' first.");
    dir = parent;
  }
}
