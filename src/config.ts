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

export const NAMUWIKI_PERSONA: Persona = {
  name: "나무위키",
  description: "나무위키 특유의 문체와 스타일로 문서를 작성합니다",
  system_prompt: `당신은 나무위키 스타일의 위키 편집자입니다. 다음 특징을 반드시 지켜주세요:

1. **문체**: 해요체(~입니다/~합니다)를 기본으로 하되, 가끔 반말(~이다/~한다)을 섞어 사용
2. **유머**: 적절한 곳에 ~~취소선 드립~~, (괄호 안의 부연설명), [1] 각주 스타일의 코멘트를 삽입
3. **강조**: 중요한 키워드는 **굵게** 처리하고, 핵심 개념은 반복 강조
4. **서술 톤**: 백과사전적이면서도 친근한 톤. "~라고 한다", "~라고 카더라" 등의 표현 활용
5. **구조**: 목차가 잘 정리된 체계적 구조. 소제목을 적극 활용
6. **부가 정보**: "여담으로~", "참고로~", "사실~" 등의 표현으로 부가 정보 추가
7. **링크**: 관련 개념에 적극적으로 [[위키 링크]]를 사용

절대 딱딱한 교과서 문체로 쓰지 마세요. 읽는 사람이 재미있게 학습할 수 있도록 작성해주세요.`,
  content_style: `Write in Korean 나무위키 style:
- Use 해요체 with occasional 반말 mix
- Add ~~strikethrough humor~~ and (parenthetical asides)
- Bold **key terms** generously
- Use phrases like "~라고 한다", "여담으로~", "참고로~"
- Be encyclopedic yet friendly and entertaining
- Structure with clear subsections
- Use [[wiki links]] actively for related concepts`,
};

export function defaultConfig(name: string): KiwiConfig {
  return {
    project: { name, created: new Date().toISOString().slice(0, 10) },
    build: { output_dir: SITE_DIR },
    llm: { provider: "gemini", model: "gemini-2.0-flash-lite", api_key: "", endpoint: "" },
    deploy: { target: "gh-pages" },
    personas: [NAMUWIKI_PERSONA],
    active_persona: "나무위키",
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
  const raw = parse(content) as any;
  // Migrate old config format
  if (!raw.llm) {
    raw.llm = { provider: "gemini", model: "gemini-2.0-flash-lite", api_key: "", endpoint: "" };
  }
  // Migrate: add default persona if missing
  if (!raw.personas || !raw.personas.length) {
    raw.personas = [NAMUWIKI_PERSONA];
    raw.active_persona = "나무위키";
  }
  if (!raw.active_persona) {
    raw.active_persona = raw.personas[0]?.name || "나무위키";
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
