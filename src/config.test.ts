import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_GEMINI_MODEL,
  defaultConfig,
  loadConfig,
  saveConfig,
  type KiwiConfig,
} from "./config";
import { StaleContentFenceError } from "./repositories/content-fence-repository";
import { Store } from "./store";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kiwimu-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

function listTemporaryConfigFiles(root: string): string[] {
  return readdirSync(root).filter(name => name.startsWith(`.${CONFIG_FILE}.`) && name.endsWith(".tmp"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("atomic configuration persistence", () => {
  test("uses the supported Gemini default and migrates only the retired exact default", () => {
    const root = makeTemporaryDirectory();
    expect(defaultConfig("Current wiki").llm.model).toBe(DEFAULT_GEMINI_MODEL);

    const legacy = defaultConfig("Legacy wiki");
    legacy.llm.model = ["gemini-3.1-flash-lite", "preview"].join("-");
    saveConfig(root, legacy);
    expect(loadConfig(root).llm.model).toBe(DEFAULT_GEMINI_MODEL);

    const custom = defaultConfig("Custom wiki");
    custom.llm.model = "gemini-custom-model";
    saveConfig(root, custom);
    expect(loadConfig(root).llm.model).toBe("gemini-custom-model");
  });

  test("synchronously replaces the config with restrictive permissions", () => {
    const root = makeTemporaryDirectory();
    const first = defaultConfig("First wiki");
    saveConfig(root, first);

    expect(loadConfig(root).project.name).toBe("First wiki");
    expect(statSync(join(root, CONFIG_FILE)).mode & 0o777).toBe(0o600);

    const second = defaultConfig("Second wiki");
    second.llm.api_key = "persisted-secret";
    saveConfig(root, second);

    const persisted = loadConfig(root);
    expect(persisted.project.name).toBe("Second wiki");
    expect(persisted.llm.api_key).toBe("persisted-secret");
    expect(statSync(join(root, CONFIG_FILE)).mode & 0o777).toBe(0o600);
    expect(listTemporaryConfigFiles(root)).toEqual([]);
  });

  test("propagates rename failures and removes the temporary file", () => {
    const root = makeTemporaryDirectory();
    mkdirSync(join(root, CONFIG_FILE));

    expect(() => saveConfig(root, defaultConfig("Blocked wiki"))).toThrow();
    expect(statSync(join(root, CONFIG_FILE)).isDirectory()).toBeTrue();
    expect(listTemporaryConfigFiles(root)).toEqual([]);
  });

  test("leaves the previous config intact when serialization fails", () => {
    const root = makeTemporaryDirectory();
    saveConfig(root, defaultConfig("Stable wiki"));
    const before = readFileSync(join(root, CONFIG_FILE), "utf8");
    const invalid = defaultConfig("Invalid wiki") as KiwiConfig & { cycle?: unknown };
    invalid.cycle = invalid;

    expect(() => saveConfig(root, invalid)).toThrow();
    expect(readFileSync(join(root, CONFIG_FILE), "utf8")).toBe(before);
    expect(listTemporaryConfigFiles(root)).toEqual([]);
  });

  test("a stale coordinated owner cannot rename a config over its replacement", async () => {
    const root = makeTemporaryDirectory();
    const staleStore = new Store(join(root, "kiwi.db"));
    const replacementStore = new Store(join(root, "kiwi.db"));
    saveConfig(root, defaultConfig("Initial wiki"));
    const staleFence = staleStore.activateContentFence({
      resource: "content-mutation",
      ownerToken: "stale-owner",
      fencingToken: 1,
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let resume!: () => void;
    const resumePromise = new Promise<void>((resolve) => { resume = resolve; });

    const stalePublication = staleStore.runWithContentFence(staleFence, async () => {
      entered();
      await resumePromise;
      staleStore.publishContent(() => saveConfig(root, defaultConfig("Stale wiki")));
    });

    try {
      await enteredPromise;
      const replacementFence = replacementStore.activateContentFence({
        resource: "content-mutation",
        ownerToken: "replacement-owner",
        fencingToken: 2,
      });
      replacementStore.runWithContentFence(replacementFence, () => {
        replacementStore.publishContent(() => saveConfig(root, defaultConfig("Replacement wiki")));
      });
      resume();

      await expect(stalePublication).rejects.toBeInstanceOf(StaleContentFenceError);
      expect(loadConfig(root).project.name).toBe("Replacement wiki");
      expect(listTemporaryConfigFiles(root)).toEqual([]);
    } finally {
      resume();
      await stalePublication.catch(() => undefined);
      replacementStore.close();
      staleStore.close();
    }
  });
});
