#!/usr/bin/env bun

import { Command } from "commander";
import { join } from "path";
import { CONFIG_FILE, DB_FILE, defaultConfig, findProjectRoot, loadConfig, saveConfig } from "./config";
import { Store } from "./store";

const program = new Command()
  .name("kiwimu")
  .description("🥝 kiwimu — 나만의 학습 위키를 만드세요")
  .version("0.2.0");

// --- init ---
program
  .command("init [name]")
  .description("빈 키위(위키 프로젝트)를 생성합니다")
  .action((name: string = "My Kiwi") => {
    const root = process.cwd();
    if (Bun.file(join(root, CONFIG_FILE)).size > 0) {
      try {
        // Check if file actually exists by trying to read
        require("fs").accessSync(join(root, CONFIG_FILE));
        console.log("\x1b[33m이미 초기화된 프로젝트입니다.\x1b[0m");
        return;
      } catch {}
    }

    const config = defaultConfig(name);
    saveConfig(root, config);

    const store = new Store(join(root, DB_FILE));
    store.initSchema();
    store.close();

    console.log(`\x1b[32m🥝 '${name}' 키위가 생성되었습니다!\x1b[0m`);
    console.log("  다음 단계: \x1b[1mkiwimu add <URL 또는 PDF>\x1b[0m");
  });

// --- add ---
program
  .command("add <source>")
  .description("URL 또는 PDF 파일을 추가합니다")
  .action(async (source: string) => {
    const root = findProjectRoot();
    const store = new Store(join(root, DB_FILE));

    const isUrl = source.startsWith("http://") || source.startsWith("https://");
    const isPdf = source.toLowerCase().endsWith(".pdf");

    if (isUrl) {
      await addUrl(store, source);
    } else if (isPdf) {
      await addPdf(store, source);
    } else {
      console.log(`\x1b[31m지원하지 않는 소스 형식: ${source}\x1b[0m`);
      console.log("URL (http/https) 또는 PDF 파일을 입력해주세요.");
      store.close();
      return;
    }

    store.close();
  });

async function addUrl(store: Store, url: string) {
  const { fetchPage, extractSections } = await import("./ingest/web");
  const { chunkSections } = await import("./pipeline/chunker");
  const { autoLinkPages } = await import("./pipeline/linker");

  console.log(`\x1b[34m📥 URL 가져오는 중: ${url}\x1b[0m`);
  const { title, html } = await fetchPage(url);
  console.log(`  제목: ${title}`);

  const source = store.addSource(url, "web", title, html);

  console.log("\x1b[34m📄 문서 분할 중...\x1b[0m");
  const sections = extractSections(html);
  const count = chunkSections(sections, source.id, store);
  console.log(`\x1b[32m✅ ${count}개 문서가 생성되었습니다.\x1b[0m`);

  console.log("\x1b[34m🔗 자동 링크 생성 중...\x1b[0m");
  const linkCount = autoLinkPages(store);
  console.log(`\x1b[32m  ${linkCount}개 링크가 생성되었습니다.\x1b[0m`);
}

async function addPdf(store: Store, pdfPath: string) {
  const { extractFromPdf } = await import("./ingest/pdf");
  const { chunkSections } = await import("./pipeline/chunker");
  const { autoLinkPages } = await import("./pipeline/linker");
  const { resolve } = await import("path");

  const absPath = resolve(pdfPath);
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    console.log(`\x1b[31m파일을 찾을 수 없습니다: ${pdfPath}\x1b[0m`);
    return;
  }

  console.log(`\x1b[34m📥 PDF 처리 중: ${pdfPath}\x1b[0m`);
  const { title, sections } = await extractFromPdf(absPath);
  console.log(`  제목: ${title}`);

  const source = store.addSource(absPath, "pdf", title, "(PDF)");

  console.log("\x1b[34m📄 문서 분할 중...\x1b[0m");
  const count = chunkSections(sections, source.id, store);
  console.log(`\x1b[32m✅ ${count}개 문서가 생성되었습니다.\x1b[0m`);

  console.log("\x1b[34m🔗 자동 링크 생성 중...\x1b[0m");
  const linkCount = autoLinkPages(store);
  console.log(`\x1b[32m  ${linkCount}개 링크가 생성되었습니다.\x1b[0m`);
}

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

    const provider: string = opts.provider || config.expand.provider;
    if (!provider) {
      console.log("\x1b[33m확장 프로바이더가 설정되지 않았습니다.\x1b[0m");
      console.log("사용법: kiwimu expand --provider anthropic");
      store.close();
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
      } catch (e: any) {
        console.log(`    \x1b[31m실패: ${e.message}\x1b[0m`);
      }
    }

    const { autoLinkPages } = await import("./pipeline/linker");
    const linkCount = autoLinkPages(store);
    console.log(`\x1b[32m✅ 확장 완료! (${linkCount}개 링크 갱신)\x1b[0m`);
    store.close();
  });

// --- build ---
program
  .command("build")
  .description("정적 위키 사이트를 생성합니다")
  .action(async () => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));

    const { buildSite } = await import("./build/renderer");

    console.log("\x1b[34m🔨 위키 빌드 중...\x1b[0m");
    const count = await buildSite(store, config, root);
    console.log(`\x1b[32m✅ ${count}개 페이지가 빌드되었습니다!\x1b[0m`);
    console.log(`  출력: ${join(root, config.build.output_dir)}/`);
    store.close();
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

    // Auto-build before deploy
    const store = new Store(join(root, DB_FILE));
    const { buildSite } = await import("./build/renderer");
    console.log("\x1b[34m🔨 빌드 중...\x1b[0m");
    const count = await buildSite(store, config, root);
    console.log(`\x1b[32m  ${count}개 페이지 빌드 완료\x1b[0m`);
    store.close();

    console.log(`\x1b[34m🚀 ${opts.target}에 배포 중...\x1b[0m`);

    if (opts.target === "gh-pages") {
      const { deployGhPages } = await import("./deploy");
      await deployGhPages(siteDir, opts.message);
      console.log("\x1b[32m✅ GitHub Pages에 배포되었습니다!\x1b[0m");
      // Try to get the pages URL
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
  .description("개발용 로컬 서버를 실행합니다")
  .option("-p, --port <port>", "포트 번호", "8000")
  .action(async (opts) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const siteDir = join(root, config.build.output_dir);

    const { existsSync } = await import("fs");
    if (!existsSync(siteDir)) {
      console.log("\x1b[33m먼저 빌드가 필요합니다: kiwimu build\x1b[0m");
      return;
    }

    const port = parseInt(opts.port);
    console.log(`\x1b[32m🥝 키위 위키 서버 시작!\x1b[0m`);
    console.log(`  http://localhost:${port}`);
    console.log("  종료하려면 Ctrl+C를 누르세요.\n");

    Bun.serve({
      port,
      async fetch(req) {
        let pathname = new URL(req.url).pathname;
        if (pathname === "/") pathname = "/index.html";

        const filePath = join(siteDir, pathname);
        const file = Bun.file(filePath);

        if (await file.exists()) {
          return new Response(file);
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  });

// --- status ---
program
  .command("status")
  .description("현재 키위 상태를 표시합니다")
  .action(() => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));

    const sources = store.listSources();
    const pages = store.listPages();
    const links = store.getAllLinks();

    console.log(`\n\x1b[1m🥝 ${config.project.name}\x1b[0m\n`);
    console.log(`  소스   ${sources.length}`);
    console.log(`  문서   ${pages.length}`);
    console.log(`  링크   ${links.length}`);
    console.log(`  빌드   ${config.build.output_dir}`);
    console.log(`  확장   ${config.expand.provider || "(없음)"}`);
    console.log(`  배포   ${config.deploy.target}`);

    if (pages.length) {
      console.log("\n\x1b[1m문서 목록:\x1b[0m");
      for (const p of pages) {
        console.log(`  • ${p.title} \x1b[2m(${p.slug})\x1b[0m`);
      }
    }

    console.log();
    store.close();
  });

program.parse();
