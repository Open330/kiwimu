#!/usr/bin/env bun

import { Command } from "commander";
import { join } from "path";
import { CONFIG_FILE, DB_FILE, defaultConfig, findProjectRoot, getActivePersona, loadConfig, saveConfig } from "./config";
import { Store } from "./store";

const program = new Command()
  .name("kiwimu")
  .description("🥝 Kiwi Mu — 나만의 학습 위키를 만드세요")
  .version("0.4.2");

// --- init ---
program
  .command("init [name]")
  .description("새 Kiwi Mu 프로젝트를 생성합니다")
  .action(async (name?: string) => {
    const root = process.cwd();
    if (Bun.file(join(root, CONFIG_FILE)).size > 0) {
      try {
        require("fs").accessSync(join(root, CONFIG_FILE));
        console.log("\x1b[33m이미 초기화된 프로젝트입니다.\x1b[0m");
        return;
      } catch {}
    }

    const p = await import("@clack/prompts");
    p.intro("🥝 Kiwi Mu — 새 학습 위키 만들기");

    const values = await p.group({
      name: () =>
        p.text({
          message: "위키 이름",
          placeholder: "My Study Wiki",
          initialValue: name || "",
          validate: (v) => (!v.trim() ? "이름을 입력해주세요" : undefined),
        }),
      provider: () =>
        p.select({
          message: "LLM 프로바이더",
          options: [
            { value: "gemini", label: "Google Gemini", hint: "무료 API key (aistudio.google.com)" },
            { value: "azure-openai", label: "Azure OpenAI" },
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic Claude" },
          ],
        }),
      model: ({ results }) =>
        p.text({
          message: "모델명",
          placeholder:
            results.provider === "gemini" ? "gemini-2.0-flash-lite" :
            results.provider === "azure-openai" ? "gpt-5-nano" :
            results.provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-20250514",
          initialValue:
            results.provider === "gemini" ? "gemini-2.0-flash-lite" :
            results.provider === "azure-openai" ? "gpt-5-nano" :
            results.provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-20250514",
        }),
      apiKey: () =>
        p.password({
          message: "API Key",
          validate: (v) => (!v.trim() ? "API Key를 입력해주세요" : undefined),
        }),
      endpoint: ({ results }) =>
        results.provider === "azure-openai"
          ? p.text({ message: "Azure Endpoint", placeholder: "https://..." })
          : Promise.resolve(""),
    });

    if (p.isCancel(values)) {
      p.cancel("취소되었습니다.");
      process.exit(0);
    }

    const config = defaultConfig(values.name as string);
    config.llm.provider = values.provider as string;
    config.llm.model = values.model as string;
    config.llm.api_key = values.apiKey as string;
    config.llm.endpoint = (values.endpoint as string) || "";
    saveConfig(root, config);

    const store = new Store(join(root, DB_FILE));
    store.initSchema();
    store.close();

    p.outro(`🥝 '${values.name}' 위키가 생성되었습니다! 다음: kiwimu add <URL 또는 파일>`);
  });

// --- add ---
program
  .command("add <source>")
  .description("URL 또는 파일을 추가합니다 (PDF, DOCX, PPTX, DOC, PPT, KEY, RTF)")
  .action(async (source: string) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const persona = getActivePersona(config);
    const store = new Store(join(root, DB_FILE));
    try {
      const isUrl = source.startsWith("http://") || source.startsWith("https://");

      if (isUrl) {
        const { validateUrl } = await import("./ingest/web");
        validateUrl(source);
        console.log(`\x1b[34m📥 URL 가져오는 중: ${source}\x1b[0m`);
        const { ingestUrl } = await import("./services/ingest");
        const result = await ingestUrl(root, store, source, config.llm, persona, (s) => console.log(`  ${s}`));
        console.log(`\x1b[32m✅ 📖 ${result.sourceCount}개 원본 + 📝 ${result.conceptCount}개 개념 문서 생성\x1b[0m`);
        console.log(`\x1b[34m📊 LLM: ${result.usage.totalCalls}회 호출, ~$${result.usage.estimatedCostUsd.toFixed(4)}\x1b[0m`);
      } else {
        const { resolve } = await import("path");
        const absPath = resolve(source);
        const file = Bun.file(absPath);
        if (!(await file.exists())) {
          console.log(`\x1b[31m파일을 찾을 수 없습니다: ${source}\x1b[0m`);
          return;
        }
        console.log(`\x1b[34m📥 파일 처리 중: ${source}\x1b[0m`);
        const { ingestFile } = await import("./services/ingest");
        const result = await ingestFile(root, store, absPath, source, config.llm, persona, (s) => console.log(`  ${s}`));
        console.log(`\x1b[32m✅ 📖 ${result.sourceCount}개 원본 + 📝 ${result.conceptCount}개 개념 문서 생성\x1b[0m`);
        console.log(`\x1b[34m📊 LLM: ${result.usage.totalCalls}회 호출, ~$${result.usage.estimatedCostUsd.toFixed(4)}\x1b[0m`);
      }
    } finally {
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
  .action(async (opts) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      const provider: string = opts.provider || (config as Record<string, unknown>).expand?.provider;
      if (!provider) {
        console.log("\x1b[33m확장 프로바이더가 설정되지 않았습니다.\x1b[0m");
        console.log("사용법: kiwimu expand --provider anthropic");
        return;
      }

      const allPages = store.listPages();
      let pages = allPages;
      if (opts.pages) {
        pages = allPages.filter((p) => (opts.pages as string[]).includes(p.slug));
      }

      console.log(`\x1b[34m🧠 ${pages.length}개 문서를 확장합니다...\x1b[0m`);

      const isCli = provider === "claude-cli" || provider === "codex-cli";
      const { expandWithApi, expandWithCli } = await import("./expand/llm");

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        console.log(`  [${i + 1}/${pages.length}] ${page.title}`);
        try {
          const newContent = isCli
            ? await expandWithCli(page, allPages, provider.replace("-cli", ""))
            : await expandWithApi(page, allPages, provider, opts.model);
          store.updatePageContent(page.id, newContent);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          console.log(`    \x1b[31m실패: ${message}\x1b[0m`);
        }
      }

      const { autoLinkPages } = await import("./pipeline/linker");
      const linkCount = autoLinkPages(store);
      console.log(`\x1b[32m✅ 확장 완료! (${linkCount}개 링크 갱신)\x1b[0m`);
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
      const { buildSite } = await import("./build/renderer");
      console.log("\x1b[34m🔨 위키 빌드 중...\x1b[0m");
      const count = await buildSite(store, config, root);
      console.log(`\x1b[32m✅ ${count}개 페이지가 빌드되었습니다!\x1b[0m`);
      console.log(`  출력: ${join(root, config.build.output_dir)}/`);
    } finally {
      store.close();
    }
  });

// --- deploy ---
program
  .command("deploy")
  .description("위키를 GitHub Pages에 배포합니다")
  .option("--target <target>", "배포 대상 (gh-pages | vercel)", "gh-pages")
  .option("--message <message>", "커밋 메시지", "deploy: update wiki")
  .action(async (opts) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const siteDir = join(root, config.build.output_dir);

    const store = new Store(join(root, DB_FILE));
    try {
      const { buildSite } = await import("./build/renderer");
      console.log("\x1b[34m🔨 빌드 중...\x1b[0m");
      const count = await buildSite(store, config, root);
      console.log(`\x1b[32m  ${count}개 페이지 빌드 완료\x1b[0m`);
    } finally {
      store.close();
    }

    console.log(`\x1b[34m🚀 ${opts.target}에 배포 중...\x1b[0m`);

    if (opts.target === "gh-pages") {
      const { deployGhPages } = await import("./deploy");
      await deployGhPages(siteDir, opts.message);
      console.log("\x1b[32m✅ GitHub Pages에 배포되었습니다!\x1b[0m");
      try {
        const proc = Bun.spawn(["gh", "repo", "view", "--json", "url", "-q", ".url"], { stdout: "pipe" });
        const repoUrl = (await new Response(proc.stdout).text()).trim();
        if (repoUrl) {
          const owner = repoUrl.split("/").slice(-2).join("/").replace("https://github.com/", "");
          const [user, repo] = owner.split("/");
          console.log(`  https://${user}.github.io/${repo}/`);
        }
      } catch {}
    } else if (opts.target === "vercel") {
      const { deployVercel } = await import("./deploy");
      await deployVercel(siteDir);
      console.log("\x1b[32m✅ Vercel에 배포되었습니다!\x1b[0m");
    } else {
      console.log(`\x1b[31m지원하지 않는 배포 대상: ${opts.target}\x1b[0m`);
    }
  });

// --- serve (dev) ---
program
  .command("serve")
  .description("위키 서버를 실행합니다 (웹에서 문서 추가 가능)")
  .option("-p, --port <port>", "포트 번호", "8000")
  .option("-H, --host <host>", "바인드 주소", "localhost")
  .action(async (opts) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const siteDir = join(root, config.build.output_dir);

    const { existsSync } = await import("fs");
    if (!existsSync(siteDir)) {
      const store = new Store(join(root, DB_FILE));
      const { buildSite } = await import("./build/renderer");
      await buildSite(store, config, root);
      store.close();
    }

    const { startServer } = await import("./server");
    startServer(root, parseInt(opts.port), opts.host);
  });

// --- status ---
program
  .command("status")
  .description("현재 키위 상태를 표시합니다")
  .action(() => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      const sources = store.listSources();
      const sourcePages = store.listSourcePages();
      const conceptPages = store.listConceptPages();
      const links = store.getAllLinks();

      console.log(`\n\x1b[1m🥝 ${config.project.name}\x1b[0m\n`);
      console.log(`  소스     ${sources.length}`);
      console.log(`  📖 원본  ${sourcePages.length}`);
      console.log(`  📝 개념  ${conceptPages.length}`);
      console.log(`  🔗 링크  ${links.length}`);
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
    } finally {
      store.close();
    }
  });

program.parse();
