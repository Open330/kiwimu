import { parse, stringify } from "smol-toml";
import { existsSync } from "fs";
import { join } from "path";

export const CONFIG_FILE = "kiwi.toml";
export const DB_FILE = "kiwi.db";
export const SITE_DIR = "_site";

export interface KiwiConfig {
  project: { name: string; created: string };
  build: { output_dir: string };
  expand: { provider: string; model: string };
  deploy: { target: string };
}

export function defaultConfig(name: string): KiwiConfig {
  return {
    project: { name, created: new Date().toISOString().slice(0, 10) },
    build: { output_dir: SITE_DIR },
    expand: { provider: "", model: "" },
    deploy: { target: "gh-pages" },
  };
}

export function saveConfig(root: string, config: KiwiConfig): void {
  Bun.write(join(root, CONFIG_FILE), stringify(config));
}

export function loadConfig(root: string): KiwiConfig {
  const content = require("fs").readFileSync(join(root, CONFIG_FILE), "utf-8");
  return parse(content) as unknown as KiwiConfig;
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
