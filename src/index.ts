#!/usr/bin/env bun

import { Command, InvalidArgumentError } from "commander";
import { join } from "path";
import { existsSync, rmSync } from "node:fs";
import pkg from "../package.json";
import { CONFIG_FILE, DB_FILE, DEFAULT_GEMINI_MODEL, DEFAULT_OLLAMA_BASE_URL, LLM_PROVIDER_OPTIONS, SUPPORTED_EXTENSIONS, defaultConfig, findProjectRoot, getActivePersona, loadConfig, saveConfig, type KiwiConfig } from "./config";
import { Store } from "./store";
import { runCliContentJob } from "./cli/content-job";
import { StaleContentFenceError } from "./repositories/content-fence-repository";
import { LeaseOwnershipLostError } from "./server/runtime";
import { formatEstimatedCost } from "./pipeline/cost-estimator";
import { captureStdoutForJson, printJson } from "./cli/json-output";

type ExpandProvider = "anthropic" | "openai" | "claude-cli" | "codex-cli";

interface ExpandCommandOptions {
  provider?: string;
  model?: string;
  pages?: string[];
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function requirePromptText(value: unknown, label: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) throw new Error(`${label} 값이 비어 있습니다.`);
  return normalized;
}

function getConfiguredExpandProvider(config: KiwiConfig): string | undefined {
  // `expand` is supported by older kiwi.toml files but is not part of the current
  // public config shape. Narrow it at runtime instead of casting the whole config.
  if (!("expand" in config)) return undefined;
  const expand = config.expand;
  if (typeof expand !== "object" || expand === null || !("provider" in expand)) return undefined;
  return normalizeOptionalText(expand.provider);
}

function parseExpandProvider(value: string | undefined): ExpandProvider | undefined {
  switch (value) {
    case undefined:
      return undefined;
    case "anthropic":
    case "openai":
    case "claude-cli":
    case "codex-cli":
      return value;
    default:
      throw new Error(`지원하지 않는 확장 프로바이더입니다: ${value}`);
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("포트는 1~65535 사이의 정수여야 합니다.");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError("포트는 1~65535 사이의 정수여야 합니다.");
  }
  return port;
}

function isContentOwnershipError(error: unknown): boolean {
  return error instanceof StaleContentFenceError || error instanceof LeaseOwnershipLostError;
}

function cleanupFailedDemoInitialization(root: string): string[] {
  const failed: string[] = [];
  for (const name of [CONFIG_FILE, DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try {
      rmSync(join(root, name), { force: true });
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

const program = new Command()
  .name("kiwimu")
  .description("🥝 Kiwi Mu — 나만의 학습 위키를 만드세요")
  .version(pkg.version);

// --- init ---
program
  .command("init [name]")
  .description("새 Kiwi Mu 프로젝트를 생성합니다")
  .option("--demo", "샘플 데이터로 즉시 체험")
  .option("--no-serve", "데모 생성 후 서버를 시작하지 않음")
  .action(async (name: string | undefined, opts: { demo?: boolean; serve?: boolean }) => {
    const root = process.cwd();
    const hasConfig = existsSync(join(root, CONFIG_FILE));
    const hasDatabase = existsSync(join(root, DB_FILE));
    if (hasConfig && hasDatabase) {
      throw new Error("이미 초기화된 프로젝트입니다. 기존 프로젝트는 변경하지 않았습니다. 상태는 'kiwimu status'로 확인하세요.");
    }
    if (hasConfig || hasDatabase) {
      throw new Error(
        `불완전한 초기화 상태입니다 (${hasConfig ? CONFIG_FILE : DB_FILE}만 존재). ` +
        "기존 파일을 백업·확인한 뒤 빈 디렉토리에서 다시 초기화하세요.",
      );
    }

    if (opts.demo) {
      // Demo mode: skip API key prompt, use sample data
      const demoName = name || "Quantum Wiki Demo";
      console.log(`\x1b[34m🥝 데모 모드로 '${demoName}' 위키를 생성합니다...\x1b[0m`);

      const config = defaultConfig(demoName);
      config.llm.provider = "demo";
      config.llm.model = "";
      config.llm.api_key = "";
      config.llm.endpoint = "";
      let store: Store | undefined;
      let initializationError: unknown;
      let count = 0;
      try {
        saveConfig(root, config);
        store = new Store(join(root, DB_FILE));

        const { setupDemo } = await import("./demo/setup");
        await setupDemo(store);

        const { buildSite } = await import("./build/renderer");
        count = await buildSite(store, config, root);
      } catch (error) {
        initializationError = error;
      } finally {
        if (store) {
          try {
            store.close();
          } catch (error) {
            initializationError ??= error;
          }
        }
      }

      if (initializationError !== undefined) {
        const cleanupFailures = cleanupFailedDemoInitialization(root);
        const reason = initializationError instanceof Error
          ? initializationError.message
          : String(initializationError);
        if (cleanupFailures.length > 0) {
          throw new Error(
            `데모 초기화 실패: ${reason}. 자동 정리에 실패한 파일: ${cleanupFailures.join(", ")}. ` +
            "파일을 백업·확인한 뒤 빈 디렉토리에서 'kiwimu init --demo'를 다시 실행하세요.",
          );
        }
        throw new Error(
          `데모 초기화 실패: ${reason}. 생성된 설정과 DB는 정리했습니다. ` +
          "원인을 해결한 뒤 'kiwimu init --demo'를 다시 실행하세요.",
        );
      }

      console.log(`\x1b[32m✅ ${count}개 페이지가 빌드되었습니다!\x1b[0m`);

      if (opts.serve === false) {
        console.log(`  출력: ${join(root, config.build.output_dir)}/`);
        return;
      }

      const { startServer } = await import("./server");
      const demoPort = parsePositiveInteger(process.env.KIWI_PORT, 8000);
      console.log(`🎉 데모 위키가 준비되었습니다! http://localhost:${demoPort} 에서 확인하세요`);
      await startServer(root, demoPort, "localhost");
      return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("대화형 init에는 TTY가 필요합니다. 자동화에서는 init --demo를 사용하세요.");
    }

    const p = await import("@clack/prompts");
    p.intro("🥝 Kiwi Mu — 새 학습 위키 만들기");

    const values = await p.group({
      name: () =>
        p.text({
          message: "위키 이름",
          placeholder: "My Study Wiki",
          initialValue: name || "",
          validate: (v) => (!v?.trim() ? "이름을 입력해주세요" : undefined),
        }),
      provider: () =>
        p.select({
          message: "LLM 프로바이더",
          options: LLM_PROVIDER_OPTIONS.map((o) => ({ value: o.value, label: o.label, ...(o.hint ? { hint: o.hint } : {}) })),
        }),
      model: ({ results }) => {
        const placeholder =
          results.provider === "gemini" ? DEFAULT_GEMINI_MODEL :
          results.provider === "azure-openai" ? "gpt-5.4-nano" :
          results.provider === "openai" ? "gpt-5.4-nano" :
          results.provider === "anthropic" ? "claude-sonnet-4-6" :
          results.provider === "ollama" ? "llama3.1" :
          results.provider === "openrouter" ? "openai/gpt-4o-mini" : "";
        // 로컬/게이트웨이 provider는 사용자가 직접 pull/선택한 모델을 쓰므로 prefill하지 않는다.
        const prefill = (results.provider === "ollama" || results.provider === "openrouter") ? "" : placeholder;
        return p.text({ message: "모델명", placeholder, initialValue: prefill });
      },
      apiKey: ({ results }) =>
        results.provider === "ollama"
          ? Promise.resolve("") // 로컬 Ollama는 API Key가 필요 없다
          : p.password({
              message: "API Key",
              validate: (v) => (!v?.trim() ? "API Key를 입력해주세요" : undefined),
            }),
      endpoint: ({ results }) =>
        results.provider === "azure-openai"
          ? p.text({ message: "Azure Endpoint", placeholder: "https://..." })
          : results.provider === "ollama"
          ? p.text({ message: "Ollama Base URL", placeholder: DEFAULT_OLLAMA_BASE_URL, initialValue: DEFAULT_OLLAMA_BASE_URL })
          : Promise.resolve(""),
    });

    if (p.isCancel(values)) {
      p.cancel("취소되었습니다.");
      process.exit(0);
    }

    const wikiName = requirePromptText(values.name, "위키 이름");
    const config = defaultConfig(wikiName);
    config.llm.provider = requirePromptText(values.provider, "LLM 프로바이더");
    config.llm.model = requirePromptText(values.model, "모델명");
    config.llm.api_key = normalizeOptionalText(values.apiKey) || "";
    config.llm.endpoint = normalizeOptionalText(values.endpoint) || "";
    saveConfig(root, config);

    const store = new Store(join(root, DB_FILE));
    store.initSchema();
    store.close();

    p.outro(`🥝 '${wikiName}' 위키가 생성되었습니다! 다음: kiwimu add <URL 또는 파일>`);
  });

// --- add ---
program
  .command("add <source>")
  .description("URL, 파일, 또는 디렉토리를 추가합니다 (PDF, DOCX, PPTX, DOC, PPT, KEY, RTF, MD)")
  .option("-y, --yes", "비용 미리보기 확인 없이 바로 진행")
  .option("-f, --force", "내용이 변경되지 않아도 강제로 재인제스트")
  .option("--json", "사람용 텍스트 대신 machine-readable JSON을 출력합니다 (비용 미리보기 확인은 --yes처럼 건너뜁니다)")
  .action(async (source: string, options: { yes?: boolean; force?: boolean; json?: boolean }) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const persona = getActivePersona(config);
    const store = new Store(join(root, DB_FILE));

    // Under --json the interactive cost-preview confirm is skipped (treated as --yes)
    // and all progress output is routed to stderr so stdout carries only the JSON.
    const jsonMode = options.json === true;
    const capture = jsonMode ? captureStdoutForJson() : null;

    // { source, added:{sources,concepts,links}, usage:{tokens,estimatedCostUsd}, skipped?, cancelled?, figures? }
    const jsonAdded = { sources: 0, concepts: 0, links: 0 };
    const jsonUsage = { tokens: 0, estimatedCostUsd: null as number | null };
    let jsonSkipped = false;
    let jsonCancelled = false;
    let jsonFigures: { figureCount: number; captionedCount: number } | undefined;
    const accumulate = (result: import("./services/ingest").IngestResult): typeof result => {
      jsonAdded.sources += result.sourceCount;
      jsonAdded.concepts += result.conceptCount;
      jsonUsage.tokens += result.usage.totalTokens;
      if (result.usage.estimatedCostUsd != null) {
        jsonUsage.estimatedCostUsd = (jsonUsage.estimatedCostUsd ?? 0) + result.usage.estimatedCostUsd;
      }
      if (result.unchanged) jsonSkipped = true;
      if (result.cancelled) jsonCancelled = true;
      if (result.figures) jsonFigures = result.figures;
      return result;
    };
    const linksBefore = store.countLinks();

    // Cost-preview confirmation hook (skipped with --yes or --json). Returns false to abort.
    const onCostEstimate = (options.yes || jsonMode) ? undefined : async (est: import("./pipeline/cost-estimator").IngestEstimate): Promise<boolean> => {
      console.log(`\x1b[34m📊 예상 사용량: ~${est.totalTokens.toLocaleString()} 토큰 (${est.chunks}청크), ${formatEstimatedCost(est.estimatedCostUsd)}\x1b[0m`);
      const { confirm, isCancel } = await import("@clack/prompts");
      const ok = await confirm({ message: "인제스트를 진행할까요?" });
      if (isCancel(ok)) return false;
      return ok === true;
    };
    try {
      await runCliContentJob(root, store, "CLI 문서 추가 중...", async ({ beforePublish }) => {
        const schema = config.schema;
        const isUrl = source.startsWith("http://") || source.startsWith("https://");
        const { publishIngestGenerationWithSite } = await import("./build/renderer");
        const ingestOpts: import("./services/ingest").IngestOptions = {
          force: options.force,
          onCostEstimate,
          publishGeneration: async (generation) => {
            const published = await publishIngestGenerationWithSite(
              store,
              generation.stagingStore,
              generation.stagingSourceId,
              generation.draft,
              generation.contentHash,
              config,
              root,
              {
                beforePublish,
                stagedFigureDirectory: generation.stagedFigureDirectory,
                publishFiles: generation.publishFiles,
              },
            );
            return published.source;
          },
        };

        if (isUrl) {
          const { validateUrl } = await import("./ingest/web");
          await validateUrl(source);
          console.log(`\x1b[34m📥 URL 가져오는 중: ${source}\x1b[0m`);
          const { ingestUrl } = await import("./services/ingest");
          const result = accumulate(await ingestUrl(root, store, source, config.llm, persona, (s) => console.log(`  ${s}`), schema, ingestOpts));
          if (result.unchanged) {
            console.log(`\x1b[33m⏭️  변경 없음 — 재인제스트를 건너뛰었습니다 (--force로 강제)\x1b[0m`);
          } else if (result.cancelled) {
            console.log(`\x1b[33m✋ 취소되었습니다\x1b[0m`);
          } else {
            console.log(`\x1b[32m✅ 📖 ${result.sourceCount}개 원본 + 📝 ${result.conceptCount}개 개념 문서 생성\x1b[0m`);
            console.log(`\x1b[34m📊 LLM: ${result.usage.totalCalls}회 호출, ${formatEstimatedCost(result.usage.estimatedCostUsd)}\x1b[0m`);
          }
        } else {
          const { resolve, basename } = await import("path");
          const absPath = resolve(source);
          const { statSync, readdirSync } = await import("fs");

          let stat;
          try {
            stat = statSync(absPath);
          } catch {
            throw new Error(`파일을 찾을 수 없습니다: ${source}`);
          }

          if (stat.isDirectory()) {
            // Find all .md files in directory
            const mdFiles = readdirSync(absPath)
              .filter(f => f.endsWith('.md'))
              .map(f => join(absPath, f));

            if (mdFiles.length === 0) {
              throw new Error("디렉토리에 .md 파일이 없습니다");
            }

            console.log(`📂 ${mdFiles.length}개 마크다운 파일 발견`);
            const { ingestFile } = await import("./services/ingest");
            for (const mdFile of mdFiles) {
              console.log(`\x1b[34m📥 파일 처리 중: ${basename(mdFile)}\x1b[0m`);
              const result = accumulate(await ingestFile(root, store, mdFile, basename(mdFile), config.llm, persona, (s) => console.log(`  ${s}`), schema, ingestOpts));
              if (result.unchanged) {
                console.log(`\x1b[33m⏭️  ${basename(mdFile)} 변경 없음 — 건너뜀\x1b[0m`);
              } else if (result.cancelled) {
                console.log(`\x1b[33m✋ ${basename(mdFile)} 및 남은 파일 처리를 취소했습니다\x1b[0m`);
                break;
              } else {
                console.log(`\x1b[32m✅ 📖 ${result.sourceCount}개 원본 + 📝 ${result.conceptCount}개 개념\x1b[0m`);
              }
            }
          } else {
            const file = Bun.file(absPath);
            if (!(await file.exists())) {
              throw new Error(`파일을 찾을 수 없습니다: ${source}`);
            }
            const ext = source.split(".").pop()?.toLowerCase() || "";
            if (!SUPPORTED_EXTENSIONS.includes(ext)) {
              throw new Error(`지원하지 않는 파일 형식입니다: .${ext}. 지원: ${SUPPORTED_EXTENSIONS.join(', ')}`);
            }
            console.log(`\x1b[34m📥 파일 처리 중: ${source}\x1b[0m`);
            const { ingestFile } = await import("./services/ingest");
            const result = accumulate(await ingestFile(root, store, absPath, source, config.llm, persona, (s) => console.log(`  ${s}`), schema, ingestOpts));
            if (result.unchanged) {
              console.log(`\x1b[33m⏭️  변경 없음 — 재인제스트를 건너뛰었습니다 (--force로 강제)\x1b[0m`);
            } else if (result.cancelled) {
              console.log(`\x1b[33m✋ 취소되었습니다\x1b[0m`);
            } else {
              console.log(`\x1b[32m✅ 📖 ${result.sourceCount}개 원본 + 📝 ${result.conceptCount}개 개념 문서 생성\x1b[0m`);
              console.log(`\x1b[34m📊 LLM: ${result.usage.totalCalls}회 호출, ${formatEstimatedCost(result.usage.estimatedCostUsd)}\x1b[0m`);
              if (result.figures && result.figures.figureCount > 0) {
                console.log(`\x1b[34m🖼️  그림 ${result.figures.figureCount}개 추출 (${result.figures.captionedCount}개 캡션)\x1b[0m`);
              }
            }
          }
        }
      });
      if (capture) {
        jsonAdded.links = store.countLinks() - linksBefore;
        capture.writeJson({
          source,
          added: jsonAdded,
          usage: jsonUsage,
          skipped: jsonSkipped,
          cancelled: jsonCancelled,
          ...(jsonFigures ? { figures: jsonFigures } : {}),
        });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      capture?.restore();
      store.close();
    }
  });

// --- expand ---
program
  .command("expand")
  .description("LLM을 사용해 문서를 확장합니다 (선택사항)")
  .option("--provider <provider>", "anthropic | openai | claude-cli | codex-cli")
  .option("--model <model>", "모델 이름")
  .option("--pages <slugs...>", "특정 페이지만 확장")
  .action(async (opts: ExpandCommandOptions) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      await runCliContentJob(root, store, "CLI 문서 확장 중...", async () => {
        const provider = parseExpandProvider(normalizeOptionalText(opts.provider) ?? getConfiguredExpandProvider(config));
        if (!provider) {
          console.log("\x1b[33m확장 프로바이더가 설정되지 않았습니다.\x1b[0m");
          console.log("사용법: kiwimu expand --provider anthropic");
          return;
        }

        const allPages = store.listPages();
        let pages = allPages;
        if (opts.pages?.length) {
          const selectedSlugs = new Set(opts.pages.map((slug) => slug.trim()).filter(Boolean));
          pages = allPages.filter((page) => selectedSlugs.has(page.slug));
        }
        if (pages.length === 0) {
          throw new Error(opts.pages?.length
            ? `요청한 문서를 찾을 수 없습니다: ${opts.pages.join(", ")}`
            : "확장할 문서가 없습니다");
        }

        console.log(`\x1b[34m🧠 ${pages.length}개 문서를 확장합니다...\x1b[0m`);

        const isCli = provider === "claude-cli" || provider === "codex-cli";
        const { expandWithApi, expandWithCli } = await import("./expand/llm");
        let succeeded = 0;
        let failed = 0;

        for (let i = 0; i < pages.length; i++) {
          const page = pages[i];
          console.log(`  [${i + 1}/${pages.length}] ${page.title}`);
          try {
            const newContent = isCli
              ? await expandWithCli(page, allPages, provider === "claude-cli" ? "claude" : "codex")
              : await expandWithApi(
                page,
                allPages,
                provider,
                normalizeOptionalText(opts.model),
                config.llm.api_key,
              );
            store.updatePageContentAsManualEdit(page.id, newContent);
            succeeded++;
          } catch (e: unknown) {
            if (isContentOwnershipError(e)) throw e;
            failed++;
            const message = e instanceof Error ? e.message : String(e);
            console.error(`    \x1b[31m❌ 실패: ${message}\x1b[0m`);
          }
        }

        let linkCount = 0;
        if (succeeded > 0) {
          const { autoLinkPages } = await import("./pipeline/linker");
          linkCount = autoLinkPages(store);
        }
        if (failed > 0) {
          throw new Error(`확장 결과: ${succeeded}개 성공, ${failed}개 실패 (${linkCount}개 링크 갱신)`);
        }
        console.log(`\x1b[32m✅ ${succeeded}개 문서 확장 완료! (${linkCount}개 링크 갱신)\x1b[0m`);
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// --- build ---
program
  .command("build")
  .description("정적 위키 사이트를 생성합니다")
  .action(async () => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      await runCliContentJob(root, store, "CLI 사이트 빌드 중...", async ({ beforePublish }) => {
        const { buildSite } = await import("./build/renderer");
        console.log("\x1b[34m🔨 위키 빌드 중...\x1b[0m");
        const count = await buildSite(store, config, root, { beforePublish });
        console.log(`\x1b[32m✅ ${count}개 페이지가 빌드되었습니다!\x1b[0m`);
        console.log(`  출력: ${join(root, config.build.output_dir)}/`);

        // Generate embeddings (optional — uses [embedding] config or falls back to [llm])
        try {
          const embConfig = config.embedding
            ? { ...config.llm, provider: config.embedding.provider, api_key: config.embedding.api_key }
            : config.llm;
          if (embConfig.api_key && embConfig.provider !== "demo") {
            const { generateMissingEmbeddings } = await import("./services/embedding");
            await generateMissingEmbeddings(store, embConfig, (msg) => console.log(msg));
            // RAG chunk-level index (incremental — only new/changed pages)
            const { indexWiki } = await import("./services/rag");
            await indexWiki(store, embConfig, { onProgress: (msg) => console.log(msg) });
          }
        } catch (e: unknown) {
          if (isContentOwnershipError(e)) throw e;
          console.log(`  ⚠ 임베딩 생성 건너뜀: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// --- index (RAG) ---
program
  .command("index")
  .description("ask-the-wiki용 시맨틱 인덱스를 증분 갱신합니다")
  .action(async () => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      await runCliContentJob(root, store, "CLI RAG 인덱스 갱신 중...", async () => {
        const embConfig = config.embedding
          ? { ...config.llm, provider: config.embedding.provider, api_key: config.embedding.api_key }
          : config.llm;
        if (!embConfig.api_key || embConfig.provider === "demo") {
          console.log("\x1b[33m임베딩 API 키가 없어 인덱싱을 건너뜁니다 (키워드 검색은 계속 동작합니다).\x1b[0m");
          return;
        }
        const { indexWiki } = await import("./services/rag");
        console.log("\x1b[34m🔎 RAG 인덱스 갱신 중...\x1b[0m");
        const result = await indexWiki(store, embConfig, { onProgress: (msg) => console.log(msg) });
        console.log(`\x1b[32m✅ 완료: ${result.pagesChunked} 페이지 재청킹, ${result.chunksEmbedded} 임베딩, ${result.skipped} 변경없음\x1b[0m`);
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// --- ask (RAG, terminal) ---
program
  .command("ask <question>")
  .description("위키 전체에 질문합니다 (RAG)")
  .option("--json", "사람용 텍스트 대신 machine-readable JSON을 출력합니다")
  .action(async (question: string, opts: { json?: boolean }) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      const embConfig = config.embedding
        ? { ...config.llm, provider: config.embedding.provider, api_key: config.embedding.api_key }
        : config.llm;
      let llm = null;
      if (config.llm.api_key && config.llm.provider !== "demo") {
        const { LLMClient } = await import("./llm-client");
        llm = new LLMClient(config.llm);
      }
      const { askWiki } = await import("./services/rag");
      const result = await askWiki(store, question, embConfig, llm);
      if (opts.json) {
        // { question, answer, citations:[{n,title,slug,snippet}], method, generated }
        printJson({
          question,
          answer: result.answer,
          citations: result.citations.map((c) => ({ n: c.n, title: c.title, slug: c.slug, snippet: c.snippet })),
          method: result.method,
          generated: result.generated,
        });
        return;
      }
      console.log(`\n${result.answer}\n`);
      if (result.citations.length) {
        console.log("\x1b[2m출처:\x1b[0m");
        for (const c of result.citations) {
          console.log(`  [${c.n}] ${c.title} (${c.slug})`);
        }
      }
      console.log(`\n\x1b[2m(${result.method}${result.generated ? "" : ", no-LLM"})\x1b[0m`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// --- deploy ---
program
  .command("deploy")
  .description("위키를 GitHub Pages에 배포합니다")
  .option("--target <target>", "배포 대상 (gh-pages | vercel)")
  .option("--message <message>", "커밋 메시지", "deploy: update wiki")
  .option("--base-path <path>", "GitHub Pages 배포 경로 (예: /kiwimu, 루트 사이트는 /)")
  .action(async (opts: { target?: string; message: string; basePath?: string }) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const siteDir = join(root, config.build.output_dir);
    const target = normalizeOptionalText(opts.target) ?? normalizeOptionalText(config.deploy.target);

    if (target !== "gh-pages" && target !== "vercel") {
      console.error(`\x1b[31m❌ 지원하지 않는 배포 대상: ${target || "(설정 없음)"}\x1b[0m`);
      process.exit(1);
    }
    if (target !== "gh-pages" && opts.basePath !== undefined) {
      console.error("\x1b[31m❌ --base-path는 GitHub Pages 배포에서만 사용할 수 있습니다.\x1b[0m");
      process.exit(1);
    }

    let ghPagesBasePath: string | undefined;
    let ghRemoteUrl: string | undefined;
    if (target === "gh-pages") {
      try {
        const { readGitOriginUrl, resolveGhPagesBasePath } = await import("./deploy");
        if (opts.basePath === undefined) ghRemoteUrl = readGitOriginUrl(root);
        ghPagesBasePath = resolveGhPagesBasePath({
          ...(opts.basePath === undefined ? { remoteUrl: ghRemoteUrl } : { basePath: opts.basePath }),
          projectRoot: root,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`\x1b[31m❌ ${message}\x1b[0m`);
        process.exit(1);
      }
    }

    const store = new Store(join(root, DB_FILE));
    try {
      await runCliContentJob(root, store, "CLI 빌드 및 배포 중...", async ({ beforePublish }) => {
        const { buildSite } = await import("./build/renderer");
        console.log("\x1b[34m🔨 빌드 중...\x1b[0m");
        const count = await buildSite(store, config, root, { beforePublish });
        console.log(`\x1b[32m  ${count}개 페이지 빌드 완료\x1b[0m`);

        console.log(`\x1b[34m🚀 ${target}에 배포 중...\x1b[0m`);
        if (target === "gh-pages") {
          const { deployGhPages, parseGitHubRemote, readGitOriginUrl } = await import("./deploy");
          await deployGhPages(siteDir, opts.message, { basePath: ghPagesBasePath, projectRoot: root });
          console.log("\x1b[32m✅ GitHub Pages에 배포되었습니다!\x1b[0m");
          try {
            ghRemoteUrl ??= readGitOriginUrl(root);
            const { owner } = parseGitHubRemote(ghRemoteUrl);
            const suffix = ghPagesBasePath === "/" ? "/" : `${ghPagesBasePath}/`;
            console.log(`  https://${owner}.github.io${suffix}`);
          } catch {
            console.log(`  GitHub Pages base path: ${ghPagesBasePath}`);
          }
        } else {
          const { deployVercel } = await import("./deploy");
          await deployVercel(siteDir);
          console.log("\x1b[32m✅ Vercel에 배포되었습니다!\x1b[0m");
        }
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ 배포 실패: ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// --- serve (dev) ---
program
  .command("serve")
  .description("위키 서버를 실행합니다 (웹에서 문서 추가 가능)")
  .option("-p, --port <port>", "포트 번호", parsePort, 8000)
  .option("-H, --host <host>", "바인드 주소", "localhost")
  .action(async (opts: { port: number; host: string }) => {
    try {
      const root = findProjectRoot();
      const config = loadConfig(root);
      const siteDir = join(root, config.build.output_dir);

      if (!existsSync(siteDir)) {
        const store = new Store(join(root, DB_FILE));
        try {
          await runCliContentJob(root, store, "서버 시작 전 사이트 빌드 중...", async ({ beforePublish }) => {
            const { buildSite } = await import("./build/renderer");
            await buildSite(store, config, root, { beforePublish });
          });
        } finally {
          store.close();
        }
      }

      const { startServer } = await import("./server");
      await startServer(root, opts.port, normalizeOptionalText(opts.host) || "localhost");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    }
  });

// --- quiz ---
program
  .command("quiz")
  .description("학습 퀴즈를 풀어봅니다")
  .option("-n, --count <count>", "문제 수", "5")
  .action(async (opts: { count: string }) => {
    const root = findProjectRoot();
    const store = new Store(join(root, DB_FILE));
    try {
      store.initSchema(); // ensure quizzes table exists
      const count = parsePositiveInteger(opts.count, 5);
      const quizzes = store.getSmartQuizzes(count);
      if (quizzes.length === 0) {
        console.log("\x1b[33m퀴즈가 없습니다. 먼저 문서를 추가하세요.\x1b[0m");
        return;
      }

      const p = await import("@clack/prompts");
      p.intro("📝 학습 퀴즈");
      console.log(`  ${quizzes.length}개 문제를 풀어봅니다.\n`);

      let score = 0;
      for (let i = 0; i < quizzes.length; i++) {
        const q = quizzes[i];
        const typeLabel = q.quiz_type === "fill_blank" ? "빈칸 채우기" : q.quiz_type === "ox" ? "OX 퀴즈" : "단답형";

        console.log(`\x1b[1m[${i + 1}/${quizzes.length}] ${typeLabel}\x1b[0m`);
        console.log(`  ${q.question}`);
        if (q.page_title) {
          console.log(`  \x1b[2m출처: ${q.page_title}\x1b[0m`);
        }

        let userAnswer: string | symbol;
        if (q.quiz_type === "ox") {
          userAnswer = await p.select({
            message: "정답은?",
            options: [
              { value: "O", label: "⭕ O" },
              { value: "X", label: "❌ X" },
            ],
          });
        } else {
          userAnswer = await p.text({
            message: "정답을 입력하세요",
            placeholder: "...",
          });
        }

        if (p.isCancel(userAnswer)) {
          p.cancel("퀴즈를 종료합니다.");
          return;
        }

        const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
        const isCorrect = norm(userAnswer as string) === norm(q.answer);

        store.addQuizAttempt(q.id, isCorrect);

        // SM-2 spaced repetition update
        const quality = isCorrect ? 4 : 1; // 4=correct with hesitation, 1=wrong
        store.updateQuizSRS(q.id, quality);

        if (isCorrect) {
          score++;
          console.log(`  \x1b[32m✅ 정답!\x1b[0m`);
        } else {
          console.log(`  \x1b[31m❌ 오답! 정답: ${q.answer}\x1b[0m`);
        }
        if (q.explanation) {
          console.log(`  \x1b[36m💡 ${q.explanation}\x1b[0m`);
        }
        console.log();
      }

      const pct = Math.round((score / quizzes.length) * 100);
      console.log(`\x1b[1m📊 결과: ${score}/${quizzes.length} (${pct}%)\x1b[0m`);
      if (pct >= 90) console.log("  🏆 완벽에 가깝습니다!");
      else if (pct >= 70) console.log("  👏 잘 하셨습니다!");
      else if (pct >= 50) console.log("  📚 조금 더 복습해보세요!");
      else console.log("  💪 다시 도전해보세요!");

      const stats = store.getQuizStats();
      if (stats.total > 0) {
        const overallPct = Math.round(stats.correct / stats.total * 100);
        console.log(`\n📊 전체 통계: ${stats.correct}/${stats.total} 정답 (${overallPct}%)`);
        if (stats.unattempted > 0) {
          console.log(`  📋 미시도 퀴즈: ${stats.unattempted}개`);
        }
      }

      p.outro("학습을 계속하세요! 🥝");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// --- lint ---
program
  .command("lint")
  .description("위키 건강 상태를 검사합니다 (orphan pages, dead links, etc.)")
  .option("--json", "사람용 텍스트 대신 machine-readable JSON을 출력합니다")
  .action(async (opts: { json?: boolean }) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      const { lintWiki } = await import("./services/lint");
      const report = lintWiki(store, config.schema);

      const { summary, issues } = report;

      if (opts.json) {
        // { ok, issues:[{type,severity,page,pageId,detail,suggestion}], counts:{...} }
        // `ok` mirrors the exit status: nonzero exit happens only when errors > 0.
        printJson({
          ok: summary.errors === 0,
          issues: issues.map((i) => ({
            type: i.type,
            severity: i.severity,
            page: i.pageTitle ?? null,
            pageId: i.pageId ?? null,
            detail: i.message,
            suggestion: i.suggestion ?? null,
          })),
          counts: {
            errors: summary.errors,
            warnings: summary.warnings,
            info: summary.info,
            total_pages: summary.total_pages,
            total_links: summary.total_links,
          },
        });
        if (summary.errors > 0) process.exit(1);
        return;
      }

      console.log(`\n\x1b[1m🔍 Wiki Lint Report\x1b[0m\n`);
      console.log(`  Pages: ${summary.total_pages}  Links: ${summary.total_links}\n`);

      if (issues.length === 0) {
        console.log("\x1b[32m  ✅ No issues found!\x1b[0m\n");
      } else {
        const errors = issues.filter(i => i.severity === 'error');
        const warnings = issues.filter(i => i.severity === 'warning');
        const infos = issues.filter(i => i.severity === 'info');

        if (errors.length > 0) {
          console.log(`\x1b[31m  ❌ Errors (${errors.length})\x1b[0m`);
          for (const issue of errors) {
            console.log(`    \x1b[31m• [${issue.type}] ${issue.message}\x1b[0m`);
            if (issue.suggestion) console.log(`      \x1b[2m→ ${issue.suggestion}\x1b[0m`);
          }
          console.log();
        }

        if (warnings.length > 0) {
          console.log(`\x1b[33m  ⚠ Warnings (${warnings.length})\x1b[0m`);
          for (const issue of warnings) {
            console.log(`    \x1b[33m• [${issue.type}] ${issue.message}\x1b[0m`);
            if (issue.suggestion) console.log(`      \x1b[2m→ ${issue.suggestion}\x1b[0m`);
          }
          console.log();
        }

        if (infos.length > 0) {
          console.log(`\x1b[36m  ℹ Info (${infos.length})\x1b[0m`);
          for (const issue of infos) {
            console.log(`    \x1b[36m• [${issue.type}] ${issue.message}\x1b[0m`);
            if (issue.suggestion) console.log(`      \x1b[2m→ ${issue.suggestion}\x1b[0m`);
          }
          console.log();
        }

        console.log(`\x1b[1m  Summary: \x1b[31m${summary.errors} errors\x1b[0m, \x1b[33m${summary.warnings} warnings\x1b[0m, \x1b[36m${summary.info} info\x1b[0m\n`);
      }

      if (summary.errors > 0) process.exit(1);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// --- cite (backfill citations) ---
program
  .command("cite")
  .description("기존 개념 페이지에 대해 인용 정보를 역추적합니다 (LLM 호출 필요)")
  .option("--dry-run", "실제 DB에 저장하지 않고 결과만 표시")
  .action(async (opts: { dryRun?: boolean }) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      await runCliContentJob(root, store, "CLI 인용 정보 생성 중...", async () => {
        const conceptPages = store.listConceptPages();
        const sourcePages = store.listSourcePages();

        if (conceptPages.length === 0) {
          console.log("\x1b[33m개념 페이지가 없습니다.\x1b[0m");
          return;
        }
        if (sourcePages.length === 0) {
          console.log("\x1b[33m원본 페이지가 없습니다.\x1b[0m");
          return;
        }
        if (!config.llm.api_key || config.llm.provider === "demo") {
          throw new Error("LLM API 키가 필요합니다.");
        }

        const { LLMClient } = await import("./llm-client");
        const llmClient = new LLMClient(config.llm);

        const sourcePageList = sourcePages.map(p => `- ${p.title} [slug: ${p.slug}]`).join("\n");

        console.log(`\x1b[34m📚 ${conceptPages.length}개 개념 페이지에 대해 인용 역추적 시작...\x1b[0m`);
        console.log(`  원본 페이지: ${sourcePages.length}개\n`);

        let totalCitations = 0;

        for (let i = 0; i < conceptPages.length; i++) {
          const page = conceptPages[i];
          console.log(`  [${i + 1}/${conceptPages.length}] ${page.title}...`);

        const system = `You analyze wiki content and identify which source pages each claim comes from.
Return valid JSON only. No markdown fences.`;

        const prompt = `Given this concept page content and a list of source pages, identify which source pages each major claim or fact comes from.

Concept page: "${page.title}"
Content:
${page.content.slice(0, 3000)}

Available source pages:
${sourcePageList}

Return a JSON array of citation matches:
[{"source_page_slug": "the-slug", "excerpt": "brief relevant quote or claim from the concept page (max 150 chars)"}]

Only include matches where you are confident the content derives from that source. Return an empty array [] if no clear matches.`;

          try {
            const raw = await llmClient.chatComplete(system, prompt, 2048);
            const cleaned = raw.replace(/^```json?\n?/m, "").replace(/\n?```\s*$/m, "").trim();
            const matches = JSON.parse(cleaned) as Array<{ source_page_slug: string; excerpt?: string }>;

            for (const match of matches) {
              const sourcePage = store.getPage(match.source_page_slug);
              if (!sourcePage || !sourcePage.source_id) continue;

              if (!opts.dryRun) {
                store.addCitation(page.id, sourcePage.source_id, sourcePage.id, match.excerpt || undefined, undefined);
              }
              totalCitations++;
              console.log(`    → ${sourcePage.title}${match.excerpt ? ': "' + match.excerpt.slice(0, 60) + '..."' : ''}`);
            }
          } catch (e: unknown) {
            if (isContentOwnershipError(e)) throw e;
            const message = e instanceof Error ? e.message : String(e);
            console.log(`    \x1b[33m⚠ 실패: ${message}\x1b[0m`);
          }
        }

        if (opts.dryRun) {
          console.log(`\n\x1b[33m🔍 DRY RUN: ${totalCitations}개 인용 발견 (저장하지 않음)\x1b[0m`);
        } else {
          console.log(`\n\x1b[32m✅ ${totalCitations}개 인용 정보가 생성되었습니다.\x1b[0m`);
          console.log(`  인용 현황: kiwimu serve 후 /provenance 페이지에서 확인`);
        }
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// --- status ---
program
  .command("status")
  .description("현재 키위 상태를 표시합니다")
  .option("--json", "사람용 텍스트 대신 machine-readable JSON을 출력합니다")
  .action((opts: { json?: boolean }) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      const sources = store.listSources();
      const sourcePages = store.listSourcePages();
      const conceptPages = store.listConceptPages();
      const linkCount = store.countLinks();

      if (opts.json) {
        // { project, pages:{source,concept,total}, sources, links, quizzes, build, deploy, sourcePages[], conceptPages[] }
        let quizzes: unknown = null;
        try {
          quizzes = store.getQuizStats();
        } catch {
          quizzes = null; // quizzes table may be absent on partially initialized projects
        }
        printJson({
          project: config.project.name,
          pages: {
            source: sourcePages.length,
            concept: conceptPages.length,
            total: sourcePages.length + conceptPages.length,
          },
          sources: sources.length,
          links: linkCount,
          quizzes,
          build: { outputDir: config.build.output_dir },
          deploy: { target: config.deploy.target },
          sourcePages: sourcePages.map((p) => ({ title: p.title, slug: p.slug })),
          conceptPages: conceptPages.map((p) => ({ title: p.title, slug: p.slug })),
        });
        return;
      }

      console.log(`\n\x1b[1m🥝 ${config.project.name}\x1b[0m\n`);
      console.log(`  소스     ${sources.length}`);
      console.log(`  📖 원본  ${sourcePages.length}`);
      console.log(`  📝 개념  ${conceptPages.length}`);
      console.log(`  🔗 링크  ${linkCount}`);
      console.log(`  빌드     ${config.build.output_dir}`);
      console.log(`  배포     ${config.deploy.target}`);

      if (sourcePages.length) {
        console.log("\n\x1b[1m📖 원본 문서:\x1b[0m");
        for (const p of sourcePages) {
          console.log(`  • ${p.title} \x1b[2m(${p.slug})\x1b[0m`);
        }
      }
      if (conceptPages.length) {
        console.log("\n\x1b[1m📝 개념 문서:\x1b[0m");
        for (const p of conceptPages) {
          console.log(`  • ${p.title} \x1b[2m(${p.slug})\x1b[0m`);
        }
      }
      console.log();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// --- log ---
program
  .command("log")
  .description("활동 로그를 표시합니다")
  .option("-n, --count <count>", "표시할 항목 수", "20")
  .option("--action <action>", "액션으로 필터링 (ingest, page_created, quiz_attempted, query 등)")
  .option("--json", "사람용 텍스트 대신 machine-readable JSON을 출력합니다")
  .action((opts: { count: string; action?: string; json?: boolean }) => {
    const root = findProjectRoot();
    const store = new Store(join(root, DB_FILE));
    try {
      const limit = parsePositiveInteger(opts.count, 20);
      const entries = store.getActivityLog(limit, 0, normalizeOptionalText(opts.action));
      if (opts.json) {
        // { entries:[{time,action,detail,entityType,entityId}], count, total } — respects --action/-n filters
        const stats = store.getActivityStats();
        printJson({
          entries: entries.map((e) => ({
            time: e.created_at,
            action: e.action,
            detail: e.title,
            entityType: e.entity_type,
            entityId: e.entity_id,
          })),
          count: entries.length,
          total: stats.total,
        });
        return;
      }
      if (entries.length === 0) {
        console.log("\x1b[33m활동 로그가 없습니다.\x1b[0m");
        return;
      }
      for (const e of entries) {
        const action = e.action.toUpperCase().padEnd(15);
        console.log(`\x1b[2m[${e.created_at}]\x1b[0m \x1b[36m[${action}]\x1b[0m ${e.title}`);
      }
      const stats = store.getActivityStats();
      console.log(`\n\x1b[2m총 ${stats.total}건\x1b[0m`);
    } finally {
      store.close();
    }
  });

// --- schema ---
program
  .command("schema")
  .description("스키마 설정을 관리합니다")
  .option("--init", "기본 [schema] 섹션을 kiwi.toml에 추가합니다")
  .option("--validate", "기존 페이지가 스키마 규칙에 부합하는지 확인합니다")
  .action(async (opts: { init?: boolean; validate?: boolean }) => {
    if (opts.init) {
      const root = findProjectRoot();
      const store = new Store(join(root, DB_FILE));
      try {
        await runCliContentJob(root, store, "CLI 스키마 설정 저장 중...", () => {
          const currentConfig = loadConfig(root);
          if (currentConfig.schema) {
            console.log("\x1b[33m[schema] 섹션이 이미 존재합니다.\x1b[0m");
            return;
          }
          currentConfig.schema = {
            categories: ["Fundamentals", "Advanced Topics", "Applications", "History", "People"],
            naming_convention: "noun_phrase",
            min_page_length: 200,
            max_page_length: 3000,
            terms: {},
            page_template: { sections: ["Definition", "Explanation", "Examples", "Related Concepts"] },
          };
          store.publishContent(() => saveConfig(root, currentConfig));
          console.log("\x1b[32m[schema] 섹션이 kiwi.toml에 추가되었습니다.\x1b[0m");
          console.log("  필요에 맞게 수정해주세요.");
        });
      } finally {
        store.close();
      }
      return;
    }

    if (opts.validate) {
      const root = findProjectRoot();
      const config = loadConfig(root);
      const schema = config.schema;

      if (!schema) {
        console.log("\x1b[33m스키마가 정의되지 않았습니다. 'kiwimu schema --init'으로 생성하세요.\x1b[0m");
        return;
      }

      const store = new Store(join(root, DB_FILE));
      try {
        const pages = store.listPages();
        let issueCount = 0;

        for (const page of pages) {
          const issues: string[] = [];

          // Check min length
          if (schema.min_page_length && page.content.length < schema.min_page_length) {
            issues.push(`길이 ${page.content.length}자 < 최소 ${schema.min_page_length}자`);
          }
          // Check max length
          if (schema.max_page_length && page.content.length > schema.max_page_length) {
            issues.push(`길이 ${page.content.length}자 > 최대 ${schema.max_page_length}자`);
          }
          // Check required sections
          if (schema.page_template?.sections?.length && page.page_type === "concept") {
            for (const section of schema.page_template.sections) {
              const sectionPattern = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "mi");
              if (!sectionPattern.test(page.content)) {
                issues.push(`누락된 섹션: "${section}"`);
              }
            }
          }
          // Check category assignment
          if (schema.categories?.length && page.page_type === "concept" && !page.category) {
            issues.push("카테고리 미지정");
          }

          if (issues.length > 0) {
            issueCount += issues.length;
            console.log(`\x1b[33m  ${page.title}\x1b[0m (${page.slug})`);
            for (const issue of issues) {
              console.log(`    - ${issue}`);
            }
          }
        }

        if (issueCount === 0) {
          console.log("\x1b[32m모든 페이지가 스키마 규칙에 부합합니다.\x1b[0m");
        } else {
          console.log(`\n\x1b[33m총 ${issueCount}개 이슈 발견 (${pages.length}개 페이지 검사)\x1b[0m`);
        }
      } finally {
        store.close();
      }
      return;
    }

    // Default: display current schema settings
    const root = findProjectRoot();
    const config = loadConfig(root);
    const schema = config.schema;

    if (!schema) {
      console.log("\x1b[33m스키마가 정의되지 않았습니다.\x1b[0m");
      console.log("  'kiwimu schema --init'으로 기본 스키마를 생성하세요.");
      return;
    }

    console.log("\n\x1b[1m[schema] 설정:\x1b[0m\n");

    if (schema.categories?.length) {
      console.log(`  카테고리: ${schema.categories.join(", ")}`);
    }
    if (schema.naming_convention) {
      console.log(`  명명 규칙: ${schema.naming_convention}`);
    }
    if (schema.min_page_length != null) {
      console.log(`  최소 페이지 길이: ${schema.min_page_length}자`);
    }
    if (schema.max_page_length != null) {
      console.log(`  최대 페이지 길이: ${schema.max_page_length}자`);
    }
    if (schema.terms && Object.keys(schema.terms).length > 0) {
      console.log(`  용어 표준화:`);
      for (const [abbrev, standard] of Object.entries(schema.terms)) {
        console.log(`    ${abbrev} -> ${standard}`);
      }
    }
    if (schema.page_template?.sections?.length) {
      console.log(`  페이지 템플릿 섹션: ${schema.page_template.sections.join(", ")}`);
    }
    console.log();
  });

try {
  await program.parseAsync();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\x1b[31m❌ ${message}\x1b[0m`);
  process.exitCode = 1;
}
