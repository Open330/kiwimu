import { join } from "path";
import path from "path";
import crypto from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { DB_FILE, SUPPORTED_EXTENSIONS, loadConfig, saveConfig, getActivePersona } from "./config";
import { Store } from "./store";
import type { KiwiConfig } from "./config";
import type { ContentIndex } from "./services/index-generator";
import { renderActivityPage } from "./build/templates";

export function startServer(root: string, port: number, host: string): void {
  const config = loadConfig(root);
  const siteDir = join(root, config.build.output_dir);
  const store = new Store(join(root, DB_FILE));

  process.on('beforeExit', () => store.close());

  let isProcessing = false;
  let processingStatus = "";

  // Cached content index for /api/index
  let cachedIndex: { data: ContentIndex; pageCount: number } | null = null;

  const askRateLimit = new Map<string, number[]>(); // ip -> timestamps
  const ASK_RATE_LIMIT = 10; // max requests
  const ASK_RATE_WINDOW = 60_000; // per minute

  // Background task tracking for dynamic Q&A
  const bgTasks = new Map<string, { status: 'processing' | 'completed' | 'error'; result?: any; error?: string }>();

  const hostname = host;

  // Persistent auth token: env var → on-disk file → fresh UUID (cached to file).
  // This keeps the manage URL stable across server restarts and lets the
  // settings page / dynamic Q&A keep working once a user has authed in once.
  const tokenFile = join(root, ".kiwi-token");
  function loadOrCreateToken(): string {
    const fromEnv = process.env.KIWIMU_AUTH_TOKEN;
    if (fromEnv && fromEnv.trim().length >= 16) return fromEnv.trim();
    try {
      const cached = readFileSync(tokenFile, "utf-8").trim();
      if (cached.length >= 16) return cached;
    } catch { /* file does not exist — fall through */ }
    const fresh = crypto.randomUUID();
    try { writeFileSync(tokenFile, fresh, { mode: 0o600 }); } catch { /* best effort */ }
    return fresh;
  }
  const authToken = loadOrCreateToken();
  const AUTH_COOKIE_NAME = "kiwi-auth";
  const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

  function readCookie(req: Request, name: string): string | null {
    const raw = req.headers.get("cookie") || "";
    const part = raw.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
    return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
  }
  function isAuthenticated(req: Request, url: URL): boolean {
    const queryToken = url.searchParams.get("token");
    const authHeader = req.headers.get("Authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const cookieToken = readCookie(req, AUTH_COOKIE_NAME);
    return queryToken === authToken || bearerToken === authToken || cookieToken === authToken;
  }
  function authCookieHeader(): string {
    return `${AUTH_COOKIE_NAME}=${encodeURIComponent(authToken)}; Path=/; Max-Age=${AUTH_COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`;
  }

  console.log(`\x1b[32m🥝 Kiwi Mu 서버 시작!\x1b[0m`);
  console.log(`  http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
  console.log(`  관리 페이지: http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}/manage?token=${authToken}`);
  console.log(`  인증 토큰: ${authToken}`);
  if (hostname === "0.0.0.0") console.log("  네트워크에 공개됨 (0.0.0.0)");
  console.log("  웹에서 문서 추가 가능합니다.\n");

  // TLS: auto-detect cert files for HTTPS
  const certPaths = [
    { cert: join(root, "certs", "fullchain.pem"), key: join(root, "certs", "privkey.pem") },
    { cert: "/etc/letsencrypt/live/internal.jiun.dev/fullchain.pem", key: "/etc/letsencrypt/live/internal.jiun.dev/privkey.pem" },
    { cert: "/certs/fullchain.pem", key: "/certs/privkey.pem" },
  ];
  const tlsConfig = certPaths.find(p => existsSync(p.cert) && existsSync(p.key));
  if (tlsConfig) {
    console.log(`  🔒 HTTPS 활성화 (${tlsConfig.cert})`);
  }

  Bun.serve({
    port,
    hostname,
    ...(tlsConfig ? { tls: { cert: Bun.file(tlsConfig.cert), key: Bun.file(tlsConfig.key) } } : {}),
    async fetch(req) {
      const url = new URL(req.url);

      // ── Auth middleware for /api/* and /admin ──
      if (url.pathname.startsWith("/api/") || url.pathname === "/manage" || url.pathname === "/activity" || url.pathname === "/provenance") {
        if (!isAuthenticated(req, url)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        // If user supplied token via ?token=…, set a cookie so subsequent
        // requests don't need it. Continue handling the request below.
        // (We set the Set-Cookie header on the eventual response in branches
        // that build their own Response; for /manage we wrap below.)
      }

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

        const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
        if (file.size > MAX_UPLOAD_SIZE) {
          return Response.json({ error: "파일 크기가 50MB를 초과합니다" }, { status: 413 });
        }

        const ext = file.name.split(".").pop()?.toLowerCase() || "";
        if (!SUPPORTED_EXTENSIONS.includes(ext)) {
          return Response.json({ error: `지원하지 않는 형식: .${ext}. 지원: ${SUPPORTED_EXTENSIONS.join(", ")}` }, { status: 400 });
        }

        // Save uploaded file
        const uploadDir = join(root, "uploads");
        const { mkdirSync } = await import("fs");
        mkdirSync(uploadDir, { recursive: true });
        const filePath = join(uploadDir, path.basename(file.name));
        await Bun.write(filePath, await file.arrayBuffer());

        isProcessing = true;
        processingStatus = "파일 처리 시작...";

        (async () => {
          try {
            const { ingestFile } = await import("./services/ingest");
            const currentConfig = loadConfig(root);
            const currentPersona = getActivePersona(currentConfig);

            await ingestFile(root, store, filePath, file.name, currentConfig.llm, currentPersona, (status) => {
              processingStatus = status;
            }, currentConfig.schema);

            processingStatus = "빌드 중...";
            const { buildSite } = await import("./build/renderer");
            await buildSite(store, loadConfig(root), root);

            processingStatus = "완료!";
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            processingStatus = `오류: ${message}`;
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

        try {
          const { validateUrl } = await import("./ingest/web");
          validateUrl(body.source);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return Response.json({ error: message }, { status: 400 });
        }

        isProcessing = true;
        processingStatus = "시작 중...";

        (async () => {
          try {
            const { ingestUrl } = await import("./services/ingest");
            const currentConfig = loadConfig(root);
            const currentPersona = getActivePersona(currentConfig);

            await ingestUrl(root, store, body.source, currentConfig.llm, currentPersona, (status) => {
              processingStatus = status;
            }, currentConfig.schema);

            processingStatus = "빌드 중...";
            const { buildSite } = await import("./build/renderer");
            await buildSite(store, loadConfig(root), root);

            processingStatus = "완료!";
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            processingStatus = `오류: ${message}`;
          } finally {
            setTimeout(() => { isProcessing = false; }, 2000);
          }
        })();

        return Response.json({ ok: true, message: "처리 시작" });
      }

      // Admin API - update LLM settings
      if (url.pathname === "/api/settings" && req.method === "POST") {
        const body = await req.json() as Record<string, string | undefined>;
        const currentConfig = loadConfig(root);
        if (body.wiki_name) currentConfig.project.name = body.wiki_name;
        if (body.provider) currentConfig.llm.provider = body.provider;
        if (body.model) currentConfig.llm.model = body.model;
        if (body.api_key !== undefined) currentConfig.llm.api_key = body.api_key ?? "";
        if (body.endpoint !== undefined) currentConfig.llm.endpoint = body.endpoint ?? "";
        saveConfig(root, currentConfig);
        // Reload config for serve
        Object.assign(config, currentConfig);

        // Auto-rebuild site with new settings
        (async () => {
          try {
            const { buildSite } = await import("./build/renderer");
            await buildSite(store, currentConfig, root);
            console.log("\x1b[32m✅ 설정 변경 후 사이트 리빌드 완료\x1b[0m");
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`\x1b[31m❌ 리빌드 실패: ${message}\x1b[0m`);
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
        const body = await req.json() as Record<string, unknown>;
        const currentConfig = loadConfig(root);
        if (!currentConfig.personas) currentConfig.personas = [];

        if (body.action === "add") {
          const persona = body.persona as { name: string; description?: string; system_prompt?: string; content_style?: string };
          const { name, description, system_prompt, content_style } = persona;
          if (!name) return Response.json({ error: "이름이 필요합니다" }, { status: 400 });
          if (currentConfig.personas.find(p => p.name === name)) {
            return Response.json({ error: "이미 존재하는 페르소나입니다" }, { status: 409 });
          }
          currentConfig.personas.push({ name, description: description || "", system_prompt: system_prompt || "", content_style: content_style || "" });
        } else if (body.action === "update") {
          const originalName = body.original_name as string;
          const persona = body.persona as { name: string; description: string; system_prompt: string; content_style: string };
          const idx = currentConfig.personas.findIndex(p => p.name === originalName);
          if (idx === -1) return Response.json({ error: "페르소나를 찾을 수 없습니다" }, { status: 404 });
          currentConfig.personas[idx] = persona;
          if (currentConfig.active_persona === originalName && persona.name !== originalName) {
            currentConfig.active_persona = persona.name;
          }
        } else if (body.action === "delete") {
          const name = body.name as string;
          currentConfig.personas = currentConfig.personas.filter(p => p.name !== name);
          if (currentConfig.active_persona === name) {
            currentConfig.active_persona = currentConfig.personas[0]?.name || "";
          }
        } else if (body.action === "activate") {
          const name = body.name as string;
          if (!currentConfig.personas.find(p => p.name === name)) {
            return Response.json({ error: "페르소나를 찾을 수 없습니다" }, { status: 404 });
          }
          currentConfig.active_persona = name;
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
            const { buildSite } = await import("./build/renderer");
            await buildSite(store, loadConfig(root), root);
            processingStatus = "빌드 완료!";
            console.log("\x1b[32m✅ 수동 빌드 완료\x1b[0m");
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            processingStatus = `빌드 오류: ${message}`;
          } finally {
            setTimeout(() => { isProcessing = false; }, 2000);
          }
        })();
        return Response.json({ ok: true, message: "빌드 시작" });
      }

      // Admin page
      if (url.pathname === "/manage") {
        const sources = store.listSourcesMeta();
        const usage = store.getUsageSummary();
        const configData = loadConfig(root);

        const { renderAdmin } = await import("./build/templates");
        const headers: Record<string, string> = { "Content-Type": "text/html" };
        if (url.searchParams.get("token") === authToken) headers["Set-Cookie"] = authCookieHeader();
        return new Response(renderAdmin({
          wikiName: configData.project.name,
          sources,
          usage,
          llmConfig: configData.llm,
          personas: configData.personas || [],
          activePersona: configData.active_persona || "",
          authToken,
        }), { headers });
      }

      if (url.pathname === "/api/ask" && req.method === "POST") {
        const clientIp = req.headers.get("x-forwarded-for") || "local";
        const now = Date.now();
        const timestamps = askRateLimit.get(clientIp) || [];
        const recent = timestamps.filter(t => now - t < ASK_RATE_WINDOW);
        if (recent.length >= ASK_RATE_LIMIT) {
          return Response.json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." }, { status: 429 });
        }
        recent.push(now);
        askRateLimit.set(clientIp, recent);

        try {
          const body = await req.json();
          const { selected_text, question, page_slug, page_id } = body;

          if (!selected_text || !page_slug) {
            return Response.json({ error: "선택한 텍스트가 필요합니다" }, { status: 400 });
          }

          const parentPage = store.getPage(page_slug);
          if (!parentPage) {
            return Response.json({ error: "페이지를 찾을 수 없습니다" }, { status: 404 });
          }

          // Auto-generate question from selected text if not provided
          const autoQuestion = question || `"${selected_text.slice(0, 100)}" 개념을 자세히 설명해주세요`;

          // Run generation in background, return task ID immediately
          const taskId = crypto.randomUUID();
          bgTasks.set(taskId, { status: 'processing' });

          (async () => {
            try {
              const currentConfig = loadConfig(root);
              const persona = getActivePersona(currentConfig);
              const { LLMClient } = await import("./llm-client");
              const llmClient = new LLMClient(currentConfig.llm);

              const { generateDynamicPage } = await import("./services/dynamic-qa");
              const result = await generateDynamicPage(store, llmClient, persona, parentPage, selected_text, autoQuestion);

              // Hot-render the new page + re-render parent page
              const { buildSinglePage } = await import("./build/renderer");
              await buildSinglePage(root, store, result.slug);
              await buildSinglePage(root, store, page_slug);

              // Check auto_promote config
              const qaConfig = currentConfig.qa;
              if (qaConfig?.auto_promote && result.isPromotable) {
                // Auto-promote: create permanent wiki page with quizzes
                try {
                  const { promoteToWiki } = await import("./services/promote");
                  const promoteResult = await promoteToWiki(store, {
                    question: autoQuestion,
                    answer: result.content,
                    title: result.suggestedTitle,
                    sourcePageId: parentPage.id,
                    selectedText: selected_text,
                  }, currentConfig.llm);

                  // Hot-render the promoted page
                  await buildSinglePage(root, store, promoteResult.slug);

                  console.log(`\x1b[32m✅ Auto-promoted: ${result.title}\x1b[0m`);
                } catch (promoteErr) {
                  console.log(`\x1b[33m⚠ Auto-promote failed: ${promoteErr}\x1b[0m`);
                }
              }

              bgTasks.set(taskId, {
                status: 'completed',
                result: {
                  ok: true,
                  slug: result.slug,
                  title: result.title,
                  url: `/wiki/${result.slug}.html`,
                  isPromotable: result.isPromotable,
                  suggestedTitle: result.suggestedTitle,
                  keyConcepts: result.keyConcepts,
                  sourcePageId: parentPage.id,
                  content: result.content,
                  question: autoQuestion,
                  selectedText: selected_text,
                }
              });
            } catch (e: unknown) {
              const message = e instanceof Error ? e.message : String(e);
              bgTasks.set(taskId, { status: 'error', error: message });
            }

            // Clean up task after 5 minutes
            setTimeout(() => bgTasks.delete(taskId), 5 * 60 * 1000);
          })();

          return Response.json({ task_id: taskId, message: "생성 시작" });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      // Background task status polling for dynamic Q&A
      if (url.pathname === "/api/ask/status" && req.method === "GET") {
        const taskId = url.searchParams.get("task_id");
        if (!taskId) {
          return Response.json({ error: "task_id가 필요합니다" }, { status: 400 });
        }
        const task = bgTasks.get(taskId);
        if (!task) {
          return Response.json({ error: "작업을 찾을 수 없습니다" }, { status: 404 });
        }
        return Response.json(task);
      }

      // ── Promote Q&A answer to permanent wiki page ──
      if (url.pathname === "/api/promote" && req.method === "POST") {
        try {
          const body = await req.json() as {
            question: string;
            answer: string;
            title: string;
            sourcePageId: number;
            selectedText?: string;
          };

          if (!body.question || !body.answer || !body.title || !body.sourcePageId) {
            return Response.json({ error: "question, answer, title, sourcePageId가 필요합니다" }, { status: 400 });
          }

          if (body.title.length > 200) {
            return Response.json({ error: "title은 200자 이하여야 합니다" }, { status: 400 });
          }
          if (body.question.length > 2000) {
            return Response.json({ error: "question은 2000자 이하여야 합니다" }, { status: 400 });
          }
          if (body.answer.length > 50000) {
            return Response.json({ error: "answer는 50000자 이하여야 합니다" }, { status: 400 });
          }

          const sourcePage = store.getPageById(body.sourcePageId);
          if (!sourcePage) {
            return Response.json({ error: "원본 페이지를 찾을 수 없습니다" }, { status: 404 });
          }

          const currentConfig = loadConfig(root);
          const { promoteToWiki } = await import("./services/promote");
          const result = await promoteToWiki(store, body, currentConfig.llm);

          // Hot-render the affected pages
          const { buildSinglePage } = await import("./build/renderer");
          await buildSinglePage(root, store, result.slug);
          await buildSinglePage(root, store, sourcePage.slug);

          return Response.json({
            ok: true,
            slug: result.slug,
            title: result.title,
            url: `/wiki/${result.slug}.html`,
            updated: !result.isNew,
            message: result.isNew ? "새 위키 페이지가 생성되었습니다" : "기존 페이지에 내용이 추가되었습니다",
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/search" && req.method === "GET") {
        const query = url.searchParams.get("q")?.trim();
        if (!query || query.length < 2) {
          return Response.json({ results: [] });
        }

        // Try semantic search first (if embeddings exist)
        try {
          const searchConfig = loadConfig(root);
          // Use embedding config if available, fall back to llm config
          const embeddingLlmConfig = searchConfig.embedding
            ? { ...searchConfig.llm, provider: searchConfig.embedding.provider, api_key: searchConfig.embedding.api_key }
            : searchConfig.llm;
          if (embeddingLlmConfig.api_key) {
            const { semanticSearch } = await import("./services/embedding");
            const semanticResults = await semanticSearch(query, store, embeddingLlmConfig, 5);
            if (semanticResults.length > 0) {
              return Response.json({
                results: semanticResults.map(r => ({
                  slug: r.slug,
                  title: r.title,
                  page_type: r.pageType,
                  origin: r.origin,
                  preview: '',
                  similarity: r.similarity
                })),
                method: 'semantic'
              });
            }
          }
        } catch {
          // Fall through to FTS/LIKE search
        }

        // Fallback: FTS5 / LIKE search
        const results = store.searchPages(query, 5);
        return Response.json({ results, method: 'fts' });
      }

      if (url.pathname === "/api/lint" && req.method === "GET") {
        try {
          const { lintWiki } = await import("./services/lint");
          const report = lintWiki(store);
          return Response.json(report);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      // Content index API
      if (url.pathname === "/api/index" && req.method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const currentPageCount = store.countPages();

        if (!refresh && cachedIndex && cachedIndex.pageCount === currentPageCount) {
          return Response.json(cachedIndex.data);
        }

        const { generateContentIndex } = await import("./services/index-generator");
        const useLLM = url.searchParams.get("llm") === "true";
        const currentConfig = loadConfig(root);
        const indexData = await generateContentIndex(store, {
          useLLM,
          llmConfig: currentConfig.llm,
        });

        cachedIndex = { data: indexData, pageCount: currentPageCount };
        return Response.json(indexData);
      }

      if (url.pathname === "/api/status") {
        const sources = store.listSourcesMeta();
        const sourcePages = store.listSourcePages();
        const conceptPages = store.listConceptPages();
        const linkCount = store.countLinks();
        const usage = store.getUsageSummary();

        return Response.json({
          processing: isProcessing,
          processingStatus,
          sources: sources.length,
          sourcePages: sourcePages.length,
          conceptPages: conceptPages.length,
          links: linkCount,
          usage,
        });
      }

      // Page edit endpoint
      if (url.pathname === "/api/page/edit" && req.method === "POST") {
        try {
          const { slug, content } = await req.json() as { slug: string; content: string };
          if (!slug || !content) {
            return Response.json({ error: "slug과 content가 필요합니다" }, { status: 400 });
          }

          const page = store.getPage(slug);
          if (!page) {
            return Response.json({ error: "페이지를 찾을 수 없습니다" }, { status: 404 });
          }

          // Update page content in DB
          store.updatePageContentBySlug(slug, content);

          // Hot-render the updated page
          const { buildSinglePage } = await import("./build/renderer");
          await buildSinglePage(root, store, slug);

          return Response.json({ ok: true, slug });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      // Citation endpoints
      if (url.pathname.match(/^\/api\/pages\/(\d+)\/citations$/) && req.method === "GET") {
        const pageId = parseInt(url.pathname.split("/")[3]);
        if (isNaN(pageId)) return Response.json({ error: "잘못된 ID입니다" }, { status: 400 });
        const citations = store.getCitationsForPage(pageId);
        return Response.json({ citations });
      }

      if (url.pathname.match(/^\/api\/sources\/(\d+)\/citations$/) && req.method === "GET") {
        const sourceId = parseInt(url.pathname.split("/")[3]);
        if (isNaN(sourceId)) return Response.json({ error: "잘못된 ID입니다" }, { status: 400 });
        const citations = store.getCitationsForSource(sourceId);
        return Response.json({ citations });
      }

      if (url.pathname === "/api/provenance" && req.method === "GET") {
        const coverage = store.getSourceCoverage();
        return Response.json({ coverage });
      }

      // Get page raw content endpoint. ?format=html also returns the rendered
      // article HTML fragment (used by the peek panel client-side).
      if (url.pathname.startsWith("/api/page/") && req.method === "GET") {
        const slug = url.pathname.replace("/api/page/", "");
        const page = store.getPage(decodeURIComponent(slug));
        if (!page) return Response.json({ error: "찾을 수 없습니다" }, { status: 404 });
        const body: Record<string, unknown> = {
          slug: page.slug,
          title: page.title,
          content: page.content,
          origin: page.origin,
        };
        if (url.searchParams.get("format") === "html") {
          const { renderPageContent } = await import("./build/renderer");
          const allSlugs = new Set(store.listPages().map(p => p.slug));
          body.html = await renderPageContent(page, allSlugs);
        }
        return Response.json(body);
      }

      // Activity log API
      if (url.pathname === "/api/activity" && req.method === "GET") {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50") || 50, 1), 200);
        const offset = Math.max(parseInt(url.searchParams.get("offset") || "0") || 0, 0);
        const action = url.searchParams.get("action") || undefined;
        const entries = store.getActivityLog(limit, offset, action);
        const stats = store.getActivityStats();
        return Response.json({ entries, total: stats.total });
      }

      // Activity log page
      if (url.pathname === "/activity") {
        const stats = store.getActivityStats();
        const html = renderActivityPage(authToken, config.project.name, stats);
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }

      // Provenance page (no auth required — it's a public view page)
      if (url.pathname === "/provenance") {
        const coverage = store.getSourceCoverage();
        const sources = store.listSourcesMeta();
        const conceptPages = store.listConceptPages();
        const sourcePages = store.listSourcePages();
        const configData = loadConfig(root);

        // Build citation matrix: for each source, which pages cite it
        const matrix: Array<{
          sourceId: number;
          sourceTitle: string;
          citationCount: number;
          pageCount: number;
          pages: Array<{ title: string; slug: string }>;
        }> = [];

        for (const cov of coverage) {
          const citations = store.getCitationsForSource(cov.sourceId);
          const pageMap = new Map<number, { title: string; slug: string }>();
          for (const c of citations) {
            if (c.page_title && c.page_slug && !pageMap.has(c.page_id)) {
              pageMap.set(c.page_id, { title: c.page_title, slug: c.page_slug });
            }
          }
          matrix.push({
            sourceId: cov.sourceId,
            sourceTitle: cov.sourceTitle,
            citationCount: cov.citationCount,
            pageCount: cov.pageCount,
            pages: Array.from(pageMap.values()),
          });
        }

        const { renderProvenancePage } = await import("./build/templates");
        return new Response(renderProvenancePage({
          wikiName: configData.project.name,
          coverage: matrix,
          sourcePages: sourcePages.map(p => ({ slug: p.slug, title: p.title })),
          conceptPages: conceptPages.map(p => ({ slug: p.slug, title: p.title })),
        }), { headers: { "Content-Type": "text/html" } });
      }

      // ── Static file serving ──
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";

      const resolved = path.resolve(join(siteDir, pathname));
      if (!resolved.startsWith(path.resolve(siteDir))) {
        return new Response("Forbidden", { status: 403 });
      }
      const staticFile = Bun.file(resolved);

      if (await staticFile.exists()) {
        const isHtml = pathname.endsWith(".html");
        const cspValue = "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net d3js.org static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src https://fonts.gstatic.com https://*.gstatic.com data:; img-src * data:; connect-src 'self' cloudflareinsights.com";
        if (isHtml) {
          const queryToken = url.searchParams.get("token");
          const isAuthed = isAuthenticated(req, url);
          if (isAuthed) {
            let html = await staticFile.text();
            if (!html.includes('kiwi-auth')) {
              html = html.replace('</head>', `<meta name="kiwi-auth" content="${authToken}"></head>`);
            }
            const headers: Record<string, string> = { "Content-Type": "text/html", "Content-Security-Policy": cspValue };
            // If token came in via query, persist it as a cookie so the user
            // doesn't need to re-paste ?token=… on every navigation.
            if (queryToken === authToken) headers["Set-Cookie"] = authCookieHeader();
            return new Response(html, { headers });
          }
        }
        if (isHtml) {
          return new Response(staticFile, { headers: { "Content-Type": "text/html", "Content-Security-Policy": cspValue } });
        }
        return new Response(staticFile);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
}

