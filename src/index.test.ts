import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB_FILE, defaultConfig, saveConfig } from "./config";
import { Store } from "./store";

const temporaryDirectories: string[] = [];
const cliEntry = join(import.meta.dir, "index.ts");

async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
  input?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processHandle = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdin: input === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && processHandle.stdin) {
    processHandle.stdin.write(input);
    processHandle.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kiwimu-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createProject(directory: string, configure?: (config: ReturnType<typeof defaultConfig>) => void): Store {
  const config = defaultConfig("CLI Test");
  configure?.(config);
  saveConfig(directory, config);
  const store = new Store(join(directory, DB_FILE));
  store.initSchema();
  return store;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI validation and errors", () => {
  test("rejects invalid serve ports before touching a project", async () => {
    for (const port of ["abc", "0", "65536"]) {
      const result = await runCli(["serve", "--port", port], temporaryDirectory());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("1~65535");
      expect(result.stderr).not.toContain("Bun v");
    }
  });

  test("formats action failures without internal stack traces", async () => {
    const result = await runCli(["status"], temporaryDirectory());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No kiwi.toml found");
    expect(result.stderr).not.toContain("at findProjectRoot");
    expect(result.stderr).not.toContain("src/config.ts:");
    expect(result.stderr).not.toContain("Bun v");
  });

  test("fails clearly instead of succeeding silently when interactive init has no TTY", async () => {
    const result = await runCli(["init"], temporaryDirectory(), {}, "");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("대화형 init에는 TTY가 필요합니다");
    expect(result.stderr).not.toContain("Bun v");
  });

  test("cleans failed demo state, supports retry, and rejects repeated init", async () => {
    if (process.platform === "win32") return;
    const directory = temporaryDirectory();
    const target = join(directory, "existing-output");
    mkdirSync(target);
    symlinkSync(target, join(directory, "_site"));

    const failed = await runCli(["init", "--demo", "--no-serve"], directory);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("데모 초기화 실패");
    expect(failed.stderr).toContain("생성된 설정과 DB는 정리했습니다");
    expect(failed.stderr).toContain("다시 실행하세요");
    for (const name of ["kiwi.toml", "kiwi.db", "kiwi.db-wal", "kiwi.db-shm"]) {
      expect(await Bun.file(join(directory, name)).exists()).toBeFalse();
    }

    rmSync(join(directory, "_site"));
    const retried = await runCli(["init", "--demo", "--no-serve"], directory);
    expect(retried.exitCode).toBe(0);
    expect(retried.stdout).toContain("페이지가 빌드되었습니다");

    const repeated = await runCli(["init", "--demo", "--no-serve"], directory);
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toContain("이미 초기화된 프로젝트입니다");
    expect(repeated.stderr).toContain("kiwimu status");
  });

  test("rejects an expand selection with no matching slugs without changing pages", async () => {
    const directory = temporaryDirectory();
    const store = createProject(directory, config => {
      config.llm.provider = "openai";
      config.llm.model = "test-model";
      config.llm.api_key = "saved-key";
    });
    store.addPage("existing", "Existing", "original content");
    store.close();

    const result = await runCli(["expand", "--provider", "openai", "--pages", "missing"], directory);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("요청한 문서를 찾을 수 없습니다: missing");

    const reopened = new Store(join(directory, DB_FILE));
    expect(reopened.getPage("existing")?.content).toBe("original content");
    reopened.close();
  });

  test("reports partial expand failures and exits nonzero instead of claiming success", async () => {
    const directory = temporaryDirectory();
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    const fakeCodex = join(binDirectory, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh
case "$*" in
  *"Current page title: Fail Page"*) echo "simulated failure" >&2; exit 3 ;;
  *) printf '%s' 'expanded content' ;;
esac
`);
    chmodSync(fakeCodex, 0o755);

    const store = createProject(directory);
    store.addPage("success", "Success Page", "original success");
    store.addPage("fail", "Fail Page", "original fail");
    store.close();

    const result = await runCli(
      ["expand", "--provider", "codex-cli"],
      directory,
      { PATH: `${binDirectory}:${process.env.PATH || ""}` },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("1개 성공, 1개 실패");
    expect(result.stdout).not.toContain("확장 완료!");

    const reopened = new Store(join(directory, DB_FILE));
    expect(reopened.getPage("success")).toMatchObject({
      content: "expanded content",
      manual_revision: 1,
    });
    expect(reopened.getPage("fail")).toMatchObject({
      content: "original fail",
      manual_revision: 0,
    });
    reopened.close();
  });

  test("passes the saved API key to API-based expand", async () => {
    const directory = temporaryDirectory();
    const store = createProject(directory, config => {
      config.llm.provider = "openai";
      config.llm.model = "test-model";
      config.llm.api_key = "saved-key";
    });
    store.addPage("api", "API Page", "original content");
    store.close();

    let authorization = "";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization") || "";
        return Response.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: "expanded by api" }, finish_reason: "stop" }],
        });
      },
    });
    try {
      const result = await runCli(
        ["expand", "--provider", "openai", "--model", "test-model", "--pages", "api"],
        directory,
        { OPENAI_API_KEY: "wrong-env-key", OPENAI_BASE_URL: `${server.url}v1` },
      );
      expect(result.exitCode).toBe(0);
      expect(authorization).toBe("Bearer saved-key");
    } finally {
      server.stop(true);
    }
  });

  test("uses config.deploy.target when --target is omitted", async () => {
    const directory = temporaryDirectory();
    const store = createProject(directory, config => { config.deploy.target = "invalid-config-target"; });
    store.close();

    const result = await runCli(["deploy"], directory);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("지원하지 않는 배포 대상: invalid-config-target");
  });

  test("does not bypass cost confirmation for directory add", async () => {
    const directory = temporaryDirectory();
    const docsDirectory = join(directory, "docs-input");
    mkdirSync(docsDirectory);
    writeFileSync(join(docsDirectory, "one.md"), `# One\n\n${"content ".repeat(20)}`);
    const store = createProject(directory, config => {
      config.llm.provider = "openai";
      config.llm.model = "test-model";
      config.llm.api_key = "must-not-be-used";
    });
    store.close();

    const result = await runCli(["add", docsDirectory], directory, {}, "n\n");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("예상 사용량");
    expect(result.stdout).toContain("남은 파일 처리를 취소했습니다");

    const reopened = new Store(join(directory, DB_FILE));
    expect(reopened.listSources()).toHaveLength(0);
    reopened.close();
  });
});

describe("CLI --json output", () => {
  test("status --json emits parseable JSON with the documented top-level keys", async () => {
    const directory = temporaryDirectory();
    const store = createProject(directory);
    store.addPage("chapter-1", "Chapter 1", "source content here", undefined, undefined, "source");
    store.addPage("neural-net", "Neural Net", "concept content here");
    store.close();

    const result = await runCli(["status", "--json"], directory);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed)).toEqual(
      expect.arrayContaining(["project", "pages", "sources", "links", "quizzes", "build", "deploy", "sourcePages", "conceptPages"]),
    );
    expect(parsed.pages).toEqual({ source: 1, concept: 1, total: 2 });
    expect(parsed.project).toBe("CLI Test");
    // No Korean human text or ANSI leaked onto stdout.
    expect(result.stdout).not.toContain("원본");
    expect(result.stdout).not.toContain("\x1b[");
  });

  test("log --json reflects the activity log and respects --action filter", async () => {
    const directory = temporaryDirectory();
    const store = createProject(directory);
    store.addActivityLog("ingest", "Ingested A", "source", 1);
    store.addActivityLog("page_created", "Created page: B", "page", 2);
    store.close();

    const all = await runCli(["log", "--json"], directory);
    expect(all.exitCode).toBe(0);
    const parsedAll = JSON.parse(all.stdout);
    expect(Object.keys(parsedAll)).toEqual(expect.arrayContaining(["entries", "count", "total"]));
    expect(Array.isArray(parsedAll.entries)).toBeTrue();
    expect(parsedAll.count).toBe(2);
    expect(parsedAll.entries[0]).toEqual(
      expect.objectContaining({ time: expect.any(String), action: expect.any(String), detail: expect.any(String) }),
    );

    const filtered = await runCli(["log", "--json", "--action", "ingest"], directory);
    const parsedFiltered = JSON.parse(filtered.stdout);
    expect(parsedFiltered.count).toBe(1);
    expect(parsedFiltered.entries[0].action).toBe("ingest");
  });

  test("log --json returns an empty envelope instead of Korean prose when the log is empty", async () => {
    const directory = temporaryDirectory();
    createProject(directory).close();

    const result = await runCli(["log", "--json"], directory);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ entries: [], count: 0 });
    expect(result.stdout).not.toContain("활동 로그가 없습니다");
  });

  test("ask --json emits question/answer/citations/method without an LLM", async () => {
    const directory = temporaryDirectory();
    createProject(directory).close();

    const result = await runCli(["ask", "무엇을 배웠나요?", "--json"], directory);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed)).toEqual(
      expect.arrayContaining(["question", "answer", "citations", "method", "generated"]),
    );
    expect(parsed.question).toBe("무엇을 배웠나요?");
    expect(Array.isArray(parsed.citations)).toBeTrue();
    expect(parsed.generated).toBeFalse();
  });

  test("lint --json emits ok/issues/counts and stays exit 0 without errors", async () => {
    const directory = temporaryDirectory();
    const store = createProject(directory);
    store.addPage("lonely", "Lonely Page", "short"); // orphan + thin content warnings, no errors
    store.close();

    const result = await runCli(["lint", "--json"], directory);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(["ok", "issues", "counts"]));
    expect(parsed.ok).toBeTrue();
    expect(Array.isArray(parsed.issues)).toBeTrue();
    expect(parsed.counts).toEqual(
      expect.objectContaining({ errors: 0, warnings: expect.any(Number), info: expect.any(Number) }),
    );
    expect(result.stdout).not.toContain("Wiki Lint Report");
  });

  test("add --json skips the cost confirm and prints one JSON document", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "note.md"), `# Note\n\n${"content ".repeat(40)}`);
    const store = createProject(directory, config => {
      config.llm.provider = "openai";
      config.llm.model = "test-model";
      config.llm.api_key = "saved-key";
    });
    store.close();

    // A single response that satisfies every ingest phase parser
    // (structure: title/content/level, concept: title/content, quiz: question/answer/type).
    const universal = JSON.stringify([{
      title: "Test Section",
      content: "This is sufficiently long markdown content reused across all ingest phases in this test.",
      level: 1,
      question: "What does this exercise verify?",
      answer: "JSON output",
      type: "short_answer",
    }]);
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: universal }, finish_reason: "stop" }],
        });
      },
    });
    try {
      const result = await runCli(
        ["add", join(directory, "note.md"), "--json"],
        directory,
        { OPENAI_API_KEY: "saved-key", OPENAI_BASE_URL: `${server.url}v1` },
      );
      expect(result.exitCode).toBe(0);
      // Cost-preview confirm is skipped under --json (no prompt prose on stdout).
      expect(result.stdout).not.toContain("예상 사용량");

      const parsed = JSON.parse(result.stdout);
      expect(Object.keys(parsed)).toEqual(expect.arrayContaining(["source", "added", "usage"]));
      expect(parsed.added).toEqual(
        expect.objectContaining({ sources: expect.any(Number), concepts: expect.any(Number), links: expect.any(Number) }),
      );
      expect(parsed.usage).toHaveProperty("tokens");
      expect(parsed.usage).toHaveProperty("estimatedCostUsd");
      expect(parsed.added.sources).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });
});
