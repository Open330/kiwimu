import { parse, stringify } from "smol-toml";
import { existsSync } from "fs";
import { join } from "path";

export const CONFIG_FILE = "kiwi.toml";
export const DB_FILE = "kiwi.db";
export const SITE_DIR = "_site";

export interface LLMConfig {
  provider: string; // "gemini" | "azure-openai" | "openai" | "anthropic"
  model: string;
  api_key: string;
  endpoint: string; // for Azure OpenAI
}

export interface KiwiConfig {
  project: { name: string; created: string };
  build: { output_dir: string };
  llm: LLMConfig;
  deploy: { target: string };
}

export function defaultConfig(name: string): KiwiConfig {
  return {
    project: { name, created: new Date().toISOString().slice(0, 10) },
    build: { output_dir: SITE_DIR },
    llm: { provider: "gemini", model: "gemini-2.0-flash-lite", api_key: "", endpoint: "" },
    deploy: { target: "gh-pages" },
  };
}

export function saveConfig(root: string, config: KiwiConfig): void {
  Bun.write(join(root, CONFIG_FILE), stringify(config));
}

export function loadConfig(root: string): KiwiConfig {
  const content = require("fs").readFileSync(join(root, CONFIG_FILE), "utf-8");
  const raw = parse(content) as any;
  // Migrate old config format
  if (!raw.llm) {
    raw.llm = { provider: "gemini", model: "gemini-2.0-flash-lite", api_key: "", endpoint: "" };
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
