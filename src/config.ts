import { parse, stringify } from "smol-toml";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";

export const CONFIG_FILE = "kiwi.toml";
export const DB_FILE = "kiwi.db";
export const SITE_DIR = "_site";
export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'pptx', 'doc', 'ppt', 'key', 'rtf'];

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

export interface KiwiConfig {
  project: { name: string; created: string };
  build: { output_dir: string };
  llm: LLMConfig;
  deploy: { target: string };
  personas?: Persona[];
  active_persona?: string; // name of the active persona
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
    llm: { provider: "gemini", model: "gemini-2.0-flash-lite", api_key: "", endpoint: "" },
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
  Bun.write(join(root, CONFIG_FILE), stringify(config));
}

export function loadConfig(root: string): KiwiConfig {
  const content = require("fs").readFileSync(join(root, CONFIG_FILE), "utf-8");
  const raw = parse(content) as Partial<KiwiConfig> & Record<string, unknown>;
  // Migrate old config format
  if (!raw.llm) {
    raw.llm = { provider: "gemini", model: "gemini-2.0-flash-lite", api_key: "", endpoint: "" };
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
