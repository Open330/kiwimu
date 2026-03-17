#!/usr/bin/env bun

import { Command } from "commander";
import { join } from "path";
import { CONFIG_FILE, DB_FILE, defaultConfig, findProjectRoot, getActivePersona, loadConfig, saveConfig } from "./config";
import { Store } from "./store";

const program = new Command()
  .name("kiwimu")
  .description("🥝 Kiwi Mu — 나만의 학습 위키를 만드세요")
  .version("0.2.0");

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

async function initLLM(root: string) {
  const config = loadConfig(root);
  const { setLLMConfig } = await import("./llm-client");
  setLLMConfig(config.llm);
}

async function addUrl(store: Store, url: string) {
  const { fetchPage } = await import("./ingest/web");
  const { llmChunkDocument, htmlToRawText } = await import("./pipeline/llm-chunker");

  const root = findProjectRoot();
  await initLLM(root);
  const config = loadConfig(root);
  const persona = getActivePersona(config);

  console.log(`\x1b[34m📥 URL 가져오는 중: ${url}\x1b[0m`);
  const { title, html } = await fetchPage(url);
  console.log(`  제목: ${title}`);

  const source = store.addSource(url, "web", title, html);
  const rawText = htmlToRawText(html);

  console.log("\x1b[34m📄 LLM 기반 문서 분석 중...\x1b[0m");
  const { sourceCount, conceptCount } = await llmChunkDocument(rawText, title, source.id, store, 0, persona);
  console.log(`\x1b[32m✅ 📖 ${sourceCount}개 원본 + 📝 ${conceptCount}개 개념 문서 생성\x1b[0m`);

  const { getUsageStats, getEstimatedCost, printUsageSummary } = await import("./llm-client");
  printUsageSummary();
  const u = getUsageStats();
  store.addUsageLog(source.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, getEstimatedCost());
}

async function addPdf(store: Store, pdfPath: string) {
  const { extractTextFromPdf } = await import("./ingest/pdf");
  const { llmChunkDocument } = await import("./pipeline/llm-chunker");
  const { resolve } = await import("path");

  const absPath = resolve(pdfPath);
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    console.log(`\x1b[31m파일을 찾을 수 없습니다: ${pdfPath}\x1b[0m`);
    return;
  }

  const root = findProjectRoot();
  await initLLM(root);
  const config = loadConfig(root);
  const persona = getActivePersona(config);

  console.log(`\x1b[34m📥 PDF 처리 중: ${pdfPath}\x1b[0m`);
  const { title, text } = await extractTextFromPdf(absPath);
  console.log(`  제목: ${title}`);
  console.log(`  텍스트 길이: ${text.length.toLocaleString()} 자`);

  const source = store.addSource(absPath, "pdf", title, "(PDF)");

  console.log("\x1b[34m📄 LLM 기반 문서 분석 중...\x1b[0m");
  const { sourceCount, conceptCount } = await llmChunkDocument(text, title, source.id, store, 0, persona);
  console.log(`\x1b[32m✅ 📖 ${sourceCount}개 원본 + 📝 ${conceptCount}개 개념 문서 생성\x1b[0m`);

  const { getUsageStats, getEstimatedCost, printUsageSummary } = await import("./llm-client");
  printUsageSummary();
  const u = getUsageStats();
  store.addUsageLog(source.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, getEstimatedCost());
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
  .description("위키 서버를 실행합니다 (웹에서 문서 추가 가능)")
  .option("-p, --port <port>", "포트 번호", "8000")
  .option("-H, --host <host>", "바인드 주소", "localhost")
  .action(async (opts) => {
    const root = findProjectRoot();
    const config = loadConfig(root);
    const siteDir = join(root, config.build.output_dir);

    const { existsSync } = await import("fs");

    // Auto-build if needed
    if (!existsSync(siteDir)) {
      const store = new Store(join(root, DB_FILE));
      const { buildSite } = await import("./build/renderer");
      await buildSite(store, config, root);
      store.close();
    }

    let isProcessing = false;
    let processingStatus = "";

    const port = parseInt(opts.port);
    const hostname = opts.host;
    console.log(`\x1b[32m🥝 Kiwi Mu 서버 시작!\x1b[0m`);
    console.log(`  http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
    if (hostname === "0.0.0.0") console.log("  네트워크에 공개됨 (0.0.0.0)");
    console.log("  웹에서 문서 추가 가능합니다.\n");

    Bun.serve({
      port,
      hostname,
      async fetch(req) {
        const url = new URL(req.url);

        // ── API endpoints ──

        // File upload endpoint
        if (url.pathname === "/api/upload" && req.method === "POST") {
          if (isProcessing) {
            return Response.json({ error: "이미 처리 중입니다", status: processingStatus }, { status: 409 });
          }

          const formData = await req.formData();
          const file = formData.get("file") as File | null;
          if (!file) {
            return Response.json({ error: "파일이 필요합니다" }, { status: 400 });
          }

          const ext = file.name.split(".").pop()?.toLowerCase() || "";
          const supported = ["pdf", "docx", "doc", "pptx", "ppt", "key", "rtf"];
          if (!supported.includes(ext)) {
            return Response.json({ error: `지원하지 않는 형식: .${ext}. 지원: ${supported.join(", ")}` }, { status: 400 });
          }

          // Save uploaded file
          const uploadDir = join(root, "uploads");
          const { mkdirSync } = await import("fs");
          mkdirSync(uploadDir, { recursive: true });
          const filePath = join(uploadDir, file.name);
          await Bun.write(filePath, await file.arrayBuffer());

          isProcessing = true;
          processingStatus = "파일 처리 시작...";

          (async () => {
            try {
              const store = new Store(join(root, DB_FILE));
              const { setLLMConfig, resetUsageStats, getUsageStats, getEstimatedCost } = await import("./llm-client");
              setLLMConfig(loadConfig(root).llm);
              const { llmChunkDocument } = await import("./pipeline/llm-chunker");
              resetUsageStats();

              let title: string;
              let text: string;

              if (ext === "pdf") {
                const { extractTextFromPdf } = await import("./ingest/pdf");
                processingStatus = "PDF 텍스트 추출 중...";
                ({ title, text } = await extractTextFromPdf(filePath));
              } else if (ext === "docx") {
                const { extractTextFromDocx } = await import("./ingest/docx");
                processingStatus = "DOCX 텍스트 추출 중...";
                ({ title, text } = await extractTextFromDocx(filePath));
              } else if (ext === "pptx") {
                const { extractTextFromPptx } = await import("./ingest/pptx");
                processingStatus = "PPTX 텍스트 추출 중...";
                ({ title, text } = await extractTextFromPptx(filePath));
              } else {
                const { extractWithTextutil } = await import("./ingest/legacy");
                processingStatus = `${ext.toUpperCase()} 텍스트 추출 중...`;
                ({ title, text } = await extractWithTextutil(filePath));
              }

              const src = store.addSource(filePath, ext, title, "(file)");
              // Clean up old pages from previous processing of same source
              store.deletePagesBySource(src.id);

              processingStatus = "LLM 분석 중...";
              const currentPersona = getActivePersona(loadConfig(root));
              await llmChunkDocument(text, title, src.id, store, 0, currentPersona);

              const u = getUsageStats();
              store.addUsageLog(src.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, getEstimatedCost());

              processingStatus = "빌드 중...";
              const { buildSite } = await import("./build/renderer");
              await buildSite(store, config, root);
              store.close();

              processingStatus = "완료!";
            } catch (e: any) {
              processingStatus = `오류: ${e.message}`;
            } finally {
              setTimeout(() => { isProcessing = false; }, 2000);
            }
          })();

          return Response.json({ ok: true, message: "파일 처리 시작" });
        }

        // URL add endpoint
        if (url.pathname === "/api/add" && req.method === "POST") {
          if (isProcessing) {
            return Response.json({ error: "이미 처리 중입니다", status: processingStatus }, { status: 409 });
          }

          const body = await req.json() as { source: string };
          if (!body.source) {
            return Response.json({ error: "source가 필요합니다" }, { status: 400 });
          }

          isProcessing = true;
          processingStatus = "시작 중...";

          (async () => {
            try {
              const store = new Store(join(root, DB_FILE));
              const { setLLMConfig, resetUsageStats, getUsageStats, getEstimatedCost } = await import("./llm-client");
              setLLMConfig(loadConfig(root).llm);
              resetUsageStats();

              const source = body.source;
              const { fetchPage } = await import("./ingest/web");
              const { llmChunkDocument, htmlToRawText } = await import("./pipeline/llm-chunker");

              processingStatus = "URL 가져오는 중...";
              const { title, html } = await fetchPage(source);
              const src = store.addSource(source, "web", title, html);
              const rawText = htmlToRawText(html);

              processingStatus = "LLM 분석 중...";
              const currentPersona = getActivePersona(loadConfig(root));
              await llmChunkDocument(rawText, title, src.id, store, 0, currentPersona);

              const u = getUsageStats();
              store.addUsageLog(src.id, u.totalCalls, u.promptTokens, u.completionTokens, u.totalTokens, getEstimatedCost());

              processingStatus = "빌드 중...";
              const { buildSite } = await import("./build/renderer");
              await buildSite(store, config, root);
              store.close();

              processingStatus = "완료!";
            } catch (e: any) {
              processingStatus = `오류: ${e.message}`;
            } finally {
              setTimeout(() => { isProcessing = false; }, 2000);
            }
          })();

          return Response.json({ ok: true, message: "처리 시작" });
        }

        // Admin API - update LLM settings
        if (url.pathname === "/api/settings" && req.method === "POST") {
          const body = await req.json() as any;
          const currentConfig = loadConfig(root);
          if (body.wiki_name) currentConfig.project.name = body.wiki_name;
          if (body.provider) currentConfig.llm.provider = body.provider;
          if (body.model) currentConfig.llm.model = body.model;
          if (body.api_key !== undefined) currentConfig.llm.api_key = body.api_key;
          if (body.endpoint !== undefined) currentConfig.llm.endpoint = body.endpoint;
          saveConfig(root, currentConfig);
          // Reload config for serve
          Object.assign(config, currentConfig);

          // Auto-rebuild site with new settings
          (async () => {
            try {
              const store = new Store(join(root, DB_FILE));
              const { buildSite } = await import("./build/renderer");
              await buildSite(store, currentConfig, root);
              store.close();
              console.log("\x1b[32m✅ 설정 변경 후 사이트 리빌드 완료\x1b[0m");
            } catch (e: any) {
              console.log(`\x1b[31m리빌드 실패: ${e.message}\x1b[0m`);
            }
          })();

          return Response.json({ ok: true });
        }

        if (url.pathname === "/api/settings" && req.method === "GET") {
          const currentConfig = loadConfig(root);
          // Mask API key
          const masked = { ...currentConfig.llm, api_key: currentConfig.llm.api_key ? "••••" + currentConfig.llm.api_key.slice(-4) : "" };
          return Response.json(masked);
        }

        // Persona API
        if (url.pathname === "/api/personas" && req.method === "GET") {
          const currentConfig = loadConfig(root);
          return Response.json({
            personas: currentConfig.personas || [],
            active: currentConfig.active_persona || "",
          });
        }

        if (url.pathname === "/api/personas" && req.method === "POST") {
          const body = await req.json() as any;
          const currentConfig = loadConfig(root);
          if (!currentConfig.personas) currentConfig.personas = [];

          if (body.action === "add") {
            const { name, description, system_prompt, content_style } = body.persona;
            if (!name) return Response.json({ error: "이름이 필요합니다" }, { status: 400 });
            if (currentConfig.personas.find(p => p.name === name)) {
              return Response.json({ error: "이미 존재하는 페르소나입니다" }, { status: 409 });
            }
            currentConfig.personas.push({ name, description: description || "", system_prompt: system_prompt || "", content_style: content_style || "" });
          } else if (body.action === "update") {
            const idx = currentConfig.personas.findIndex(p => p.name === body.original_name);
            if (idx === -1) return Response.json({ error: "페르소나를 찾을 수 없습니다" }, { status: 404 });
            currentConfig.personas[idx] = body.persona;
            if (currentConfig.active_persona === body.original_name && body.persona.name !== body.original_name) {
              currentConfig.active_persona = body.persona.name;
            }
          } else if (body.action === "delete") {
            currentConfig.personas = currentConfig.personas.filter(p => p.name !== body.name);
            if (currentConfig.active_persona === body.name) {
              currentConfig.active_persona = currentConfig.personas[0]?.name || "";
            }
          } else if (body.action === "activate") {
            if (!currentConfig.personas.find(p => p.name === body.name)) {
              return Response.json({ error: "페르소나를 찾을 수 없습니다" }, { status: 404 });
            }
            currentConfig.active_persona = body.name;
          }

          saveConfig(root, currentConfig);
          Object.assign(config, currentConfig);
          return Response.json({ ok: true, personas: currentConfig.personas, active: currentConfig.active_persona });
        }

        // Build API
        if (url.pathname === "/api/build" && req.method === "POST") {
          if (isProcessing) {
            return Response.json({ error: "이미 처리 중입니다" }, { status: 409 });
          }
          isProcessing = true;
          processingStatus = "빌드 중...";
          (async () => {
            try {
              const store = new Store(join(root, DB_FILE));
              const { buildSite } = await import("./build/renderer");
              await buildSite(store, loadConfig(root), root);
              store.close();
              processingStatus = "빌드 완료!";
              console.log("\x1b[32m✅ 수동 빌드 완료\x1b[0m");
            } catch (e: any) {
              processingStatus = `빌드 오류: ${e.message}`;
            } finally {
              setTimeout(() => { isProcessing = false; }, 2000);
            }
          })();
          return Response.json({ ok: true, message: "빌드 시작" });
        }

        // Admin page
        if (url.pathname === "/admin") {
          const store = new Store(join(root, DB_FILE));
          const sources = store.listSources();
          const usage = store.getUsageSummary();
          const configData = loadConfig(root);
          store.close();

          const { renderAdmin } = await import("./build/templates");
          return new Response(renderAdmin({
            wikiName: configData.project.name,
            sources,
            usage,
            llmConfig: configData.llm,
            personas: configData.personas || [],
            activePersona: configData.active_persona || "",
          }), { headers: { "Content-Type": "text/html" } });
        }

        if (url.pathname === "/api/status") {
          const store = new Store(join(root, DB_FILE));
          const sources = store.listSources();
          const sourcePages = store.listSourcePages();
          const conceptPages = store.listConceptPages();
          const links = store.getAllLinks();
          const usage = store.getUsageSummary();
          store.close();

          return Response.json({
            processing: isProcessing,
            processingStatus,
            sources: sources.length,
            sourcePages: sourcePages.length,
            conceptPages: conceptPages.length,
            links: links.length,
            usage,
          });
        }

        // ── Static file serving ──
        let pathname = url.pathname;
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
    store.close();
  });

program.parse();
