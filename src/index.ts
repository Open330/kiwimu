#!/usr/bin/env bun

import { Command } from "commander";
import { join } from "path";
import { CONFIG_FILE, DB_FILE, SUPPORTED_EXTENSIONS, defaultConfig, findProjectRoot, getActivePersona, loadConfig, saveConfig } from "./config";
import { Store } from "./store";

const program = new Command()
  .name("kiwimu")
  .description("🥝 Kiwi Mu — 나만의 학습 위키를 만드세요")
  .version("0.8.0");

// --- init ---
program
  .command("init [name]")
  .description("새 Kiwi Mu 프로젝트를 생성합니다")
  .option("--demo", "샘플 데이터로 즉시 체험")
  .action(async (name: string | undefined, opts: { demo?: boolean }) => {
    const root = process.cwd();

    if (opts.demo) {
      // Demo mode: skip API key prompt, use sample data
      const demoName = name || "Quantum Wiki Demo";
      console.log(`\x1b[34m🥝 데모 모드로 '${demoName}' 위키를 생성합니다...\x1b[0m`);

      const config = defaultConfig(demoName);
      config.llm.provider = "demo";
      config.llm.model = "";
      config.llm.api_key = "";
      config.llm.endpoint = "";
      saveConfig(root, config);

      const store = new Store(join(root, DB_FILE));
      store.initSchema();

      const { setupDemo } = await import("./demo/setup");
      await setupDemo(store);

      const { buildSite } = await import("./build/renderer");
      const count = await buildSite(store, config, root);
      store.close();

      console.log(`\x1b[32m✅ ${count}개 페이지가 빌드되었습니다!\x1b[0m`);

      const { startServer } = await import("./server");
      const demoPort = parseInt(process.env.KIWI_PORT || '8000', 10);
      console.log(`🎉 데모 위키가 준비되었습니다! http://localhost:${demoPort} 에서 확인하세요`);
      startServer(root, demoPort, "localhost");
      return;
    }

    if (Bun.file(join(root, CONFIG_FILE)).size > 0) {
      try {
        const { accessSync } = await import("fs");
        accessSync(join(root, CONFIG_FILE));
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
            results.provider === "gemini" ? "gemini-3.1-flash-lite-preview" :
            results.provider === "azure-openai" ? "gpt-5.4-nano" :
            results.provider === "openai" ? "gpt-5.4-nano" : "claude-sonnet-4-6",
          initialValue:
            results.provider === "gemini" ? "gemini-3.1-flash-lite-preview" :
            results.provider === "azure-openai" ? "gpt-5.4-nano" :
            results.provider === "openai" ? "gpt-5.4-nano" : "claude-sonnet-4-6",
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
  .description("URL, 파일, 또는 디렉토리를 추가합니다 (PDF, DOCX, PPTX, DOC, PPT, KEY, RTF, MD)")
  .action(async (source: string) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const persona = getActivePersona(config);
    const store = new Store(join(root, DB_FILE));
    try {
      const schema = config.schema;
      const isUrl = source.startsWith("http://") || source.startsWith("https://");

      if (isUrl) {
        const { validateUrl } = await import("./ingest/web");
        validateUrl(source);
        console.log(`\x1b[34m📥 URL 가져오는 중: ${source}\x1b[0m`);
        const { ingestUrl } = await import("./services/ingest");
        const result = await ingestUrl(root, store, source, config.llm, persona, (s) => console.log(`  ${s}`), schema);
        console.log(`\x1b[32m✅ 📖 ${result.sourceCount}개 원본 + 📝 ${result.conceptCount}개 개념 문서 생성\x1b[0m`);
        console.log(`\x1b[34m📊 LLM: ${result.usage.totalCalls}회 호출, ~$${result.usage.estimatedCostUsd.toFixed(4)}\x1b[0m`);
      } else {
        const { resolve, basename } = await import("path");
        const absPath = resolve(source);
        const { statSync, readdirSync } = await import("fs");

        let stat;
        try {
          stat = statSync(absPath);
        } catch {
          console.error(`\x1b[31m❌ 파일을 찾을 수 없습니다: ${source}\x1b[0m`);
          process.exit(1);
        }

        if (stat.isDirectory()) {
          // Find all .md files in directory
          const mdFiles = readdirSync(absPath)
            .filter(f => f.endsWith('.md'))
            .map(f => join(absPath, f));

          if (mdFiles.length === 0) {
            console.error("디렉토리에 .md 파일이 없습니다");
            process.exit(1);
          }

          console.log(`📂 ${mdFiles.length}개 마크다운 파일 발견`);
          const { ingestFile } = await import("./services/ingest");
          for (const mdFile of mdFiles) {
            console.log(`\x1b[34m📥 파일 처리 중: ${basename(mdFile)}\x1b[0m`);
            const result = await ingestFile(root, store, mdFile, basename(mdFile), config.llm, persona, (s) => console.log(`  ${s}`), schema);
            console.log(`\x1b[32m✅ 📖 ${result.sourceCount}개 원본 + 📝 ${result.conceptCount}개 개념\x1b[0m`);
          }
        } else {
          const file = Bun.file(absPath);
          if (!(await file.exists())) {
            console.error(`\x1b[31m❌ 파일을 찾을 수 없습니다: ${source}\x1b[0m`);
            process.exit(1);
          }
          const ext = source.split(".").pop()?.toLowerCase() || "";
          if (!SUPPORTED_EXTENSIONS.includes(ext)) {
            console.error(`\x1b[31m❌ 지원하지 않는 파일 형식입니다: .${ext}\x1b[0m`);
            console.error(`   지원 형식: ${SUPPORTED_EXTENSIONS.join(', ')}`);
            process.exit(1);
          }
          console.log(`\x1b[34m📥 파일 처리 중: ${source}\x1b[0m`);
          const { ingestFile } = await import("./services/ingest");
          const result = await ingestFile(root, store, absPath, source, config.llm, persona, (s) => console.log(`  ${s}`), schema);
          console.log(`\x1b[32m✅ 📖 ${result.sourceCount}개 원본 + 📝 ${result.conceptCount}개 개념 문서 생성\x1b[0m`);
          console.log(`\x1b[34m📊 LLM: ${result.usage.totalCalls}회 호출, ~$${result.usage.estimatedCostUsd.toFixed(4)}\x1b[0m`);
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ ${message}\x1b[0m`);
      process.exit(1);
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
          console.error(`    \x1b[31m❌ 실패: ${message}\x1b[0m`);
        }
      }

      const { autoLinkPages } = await import("./pipeline/linker");
      const linkCount = autoLinkPages(store);
      console.log(`\x1b[32m✅ 확장 완료! (${linkCount}개 링크 갱신)\x1b[0m`);
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
      const { buildSite } = await import("./build/renderer");
      console.log("\x1b[34m🔨 위키 빌드 중...\x1b[0m");
      const count = await buildSite(store, config, root);
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
        }
      } catch (e: unknown) {
        console.log(`  ⚠ 임베딩 생성 건너뜀: ${e instanceof Error ? e.message : String(e)}`);
      }
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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ 빌드 실패: ${message}\x1b[0m`);
      process.exit(1);
    } finally {
      store.close();
    }

    try {
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
        console.error(`\x1b[31m❌ 지원하지 않는 배포 대상: ${opts.target}\x1b[0m`);
        process.exit(1);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31m❌ 배포 실패: ${message}\x1b[0m`);
      process.exit(1);
    }
  });

// --- serve (dev) ---
program
  .command("serve")
  .description("위키 서버를 실행합니다 (웹에서 문서 추가 가능)")
  .option("-p, --port <port>", "포트 번호", "8000")
  .option("-H, --host <host>", "바인드 주소", "localhost")
  .action(async (opts) => {
    try {
      const root = findProjectRoot();
      const config = loadConfig(root);
      const siteDir = join(root, config.build.output_dir);

      const { existsSync } = await import("fs");
      if (!existsSync(siteDir)) {
        const store = new Store(join(root, DB_FILE));
        try {
          const { buildSite } = await import("./build/renderer");
          await buildSite(store, config, root);
        } finally {
          store.close();
        }
      }

      const { startServer } = await import("./server");
      startServer(root, parseInt(opts.port), opts.host);
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
  .action(async (opts) => {
    const root = findProjectRoot();
    const store = new Store(join(root, DB_FILE));
    try {
      store.initSchema(); // ensure quizzes table exists
      const count = parseInt(opts.count) || 5;
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
  .action(async () => {
    const root = findProjectRoot();
    const store = new Store(join(root, DB_FILE));
    try {
      const { lintWiki } = await import("./services/lint");
      const report = lintWiki(store);

      const { summary, issues } = report;

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
        console.error("\x1b[31m❌ LLM API 키가 필요합니다.\x1b[0m");
        process.exit(1);
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
          let cleaned = raw.replace(/^```json?\n?/m, "").replace(/\n?```\s*$/m, "").trim();
          const matches = JSON.parse(cleaned) as Array<{ source_page_slug: string; excerpt?: string }>;

          for (const match of matches) {
            const sourcePage = store.getPage(match.source_page_slug);
            if (!sourcePage || !sourcePage.source_id) continue;

            if (!opts.dryRun) {
              store.addCitation(page.id, sourcePage.source_id, sourcePage.id, match.excerpt || null, null);
            }
            totalCitations++;
            console.log(`    → ${sourcePage.title}${match.excerpt ? ': "' + match.excerpt.slice(0, 60) + '..."' : ''}`);
          }
        } catch (e: unknown) {
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
  .action(() => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const store = new Store(join(root, DB_FILE));
    try {
      const sources = store.listSources();
      const sourcePages = store.listSourcePages();
      const conceptPages = store.listConceptPages();
      const linkCount = store.countLinks();

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
  .action((opts) => {
    const root = findProjectRoot();
    const store = new Store(join(root, DB_FILE));
    try {
      const limit = parseInt(opts.count) || 20;
      const entries = store.getActivityLog(limit, 0, opts.action || undefined);
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
      // Generate default schema section and append to kiwi.toml
      const root = findProjectRoot();
      const { readFileSync, writeFileSync } = await import("fs");
      const configPath = join(root, CONFIG_FILE);
      const existing = readFileSync(configPath, "utf-8");

      if (existing.includes("[schema]")) {
        console.log("\x1b[33m[schema] 섹션이 이미 존재합니다.\x1b[0m");
        return;
      }

      const defaultSchema = `
[schema]
# Wiki structure rules
categories = ["Fundamentals", "Advanced Topics", "Applications", "History", "People"]
# Naming conventions: 'noun_phrase', 'question', 'topic'
naming_convention = "noun_phrase"
# Content length rules (characters)
min_page_length = 200
max_page_length = 3000

[schema.terms]
# Term standardization: abbreviation = "Standard Form"
# "ML" = "Machine Learning"
# "DL" = "Deep Learning"

[schema.page_template]
sections = ["Definition", "Explanation", "Examples", "Related Concepts"]
`;
      writeFileSync(configPath, existing.trimEnd() + "\n" + defaultSchema);
      console.log("\x1b[32m[schema] 섹션이 kiwi.toml에 추가되었습니다.\x1b[0m");
      console.log("  필요에 맞게 수정해주세요.");
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

program.parse();
