import { join } from "path";
import path from "path";
import crypto from "crypto";
import { existsSync } from "fs";
import { DB_FILE, SUPPORTED_EXTENSIONS, loadConfig, saveConfig, getActivePersona } from "./config";
import { Store } from "./store";
import type { KiwiConfig } from "./config";

export function startServer(root: string, port: number, host: string): void {
  const config = loadConfig(root);
  const siteDir = join(root, config.build.output_dir);
  const store = new Store(join(root, DB_FILE));

  process.on('beforeExit', () => store.close());

  let isProcessing = false;
  let processingStatus = "";

  // Cached content index for /api/index
  let cachedIndex: { data: any; pageCount: number } | null = null;

  const askRateLimit = new Map<string, number[]>(); // ip -> timestamps
  const ASK_RATE_LIMIT = 10; // max requests
  const ASK_RATE_WINDOW = 60_000; // per minute

  // Background task tracking for dynamic Q&A
  const bgTasks = new Map<string, { status: 'processing' | 'completed' | 'error'; result?: any; error?: string }>();

  const hostname = host;
  const authToken = crypto.randomUUID();
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
      if (url.pathname.startsWith("/api/") || url.pathname === "/manage") {
        const authHeader = req.headers.get("Authorization");
        const queryToken = url.searchParams.get("token");
        const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (bearerToken !== authToken && queryToken !== authToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
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
            });

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
            });

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
        return new Response(renderAdmin({
          wikiName: configData.project.name,
          sources,
          usage,
          llmConfig: configData.llm,
          personas: configData.personas || [],
          activePersona: configData.active_persona || "",
          authToken,
        }), { headers: { "Content-Type": "text/html" } });
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

              bgTasks.set(taskId, {
                status: 'completed',
                result: {
                  ok: true,
                  slug: result.slug,
                  title: result.title,
                  url: `/wiki/${result.slug}.html`
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
          const report = await lintWiki(store);
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
        const links = store.getAllLinks();
        const usage = store.getUsageSummary();

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

      // Get page raw content endpoint
      if (url.pathname.startsWith("/api/page/") && req.method === "GET") {
        const slug = url.pathname.replace("/api/page/", "");
        const page = store.getPage(decodeURIComponent(slug));
        if (!page) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json({ slug: page.slug, title: page.title, content: page.content, origin: page.origin });
      }

      // Activity log API
      if (url.pathname === "/api/activity" && req.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "50") || 50;
        const offset = parseInt(url.searchParams.get("offset") || "0") || 0;
        const action = url.searchParams.get("action") || undefined;
        const entries = store.getActivityLog(limit, offset, action);
        return Response.json(entries);
      }

      // Activity log page
      if (url.pathname === "/activity") {
        const stats = store.getActivityStats();
        const html = renderActivityPage(authToken, config.project.name, stats);
        return new Response(html, { headers: { "Content-Type": "text/html" } });
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
        const cspValue = "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net d3js.org static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net fonts.googleapis.com; font-src fonts.gstatic.com *.gstatic.com; img-src * data:; connect-src 'self' cloudflareinsights.com";
        if (isHtml && authToken) {
          let html = await staticFile.text();
          if (!html.includes('kiwi-auth')) {
            html = html.replace('</head>', `<meta name="kiwi-auth" content="${authToken}"></head>`);
          }
          return new Response(html, { headers: { "Content-Type": "text/html", "Content-Security-Policy": cspValue } });
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

function renderActivityPage(
  authToken: string,
  wikiName: string,
  stats: { total: number; byAction: Record<string, number>; recentDays: { date: string; count: number }[] }
): string {
  const actionIcons: Record<string, string> = {
    ingest: "📥", page_created: "📄", page_updated: "✏️", quiz_generated: "🧩",
    quiz_attempted: "📝", query: "❓", build: "🔨", deploy: "🚀", expand: "🧠",
  };
  const actionLabels: Record<string, string> = {
    ingest: "Ingest", page_created: "Page Created", page_updated: "Page Updated",
    quiz_generated: "Quiz Generated", quiz_attempted: "Quiz Attempted", query: "Q&A",
    build: "Build", deploy: "Deploy", expand: "Expand",
  };
  const filterButtons = Object.entries(stats.byAction)
    .map(([action, count]) => `<button class="filter-btn" data-action="${action}">${actionIcons[action] || "📌"} ${actionLabels[action] || action} <span class="count">(${count})</span></button>`)
    .join("\n          ");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="kiwi-auth" content="${authToken}">
  <title>Activity Log - ${wikiName}</title>
  <style>
    :root { --bg: #fff; --fg: #1a1a2e; --card-bg: #f8f9fa; --border: #e0e0e0; --accent: #4a90d9; --muted: #6c757d; --badge-bg: #e8f0fe; --badge-fg: #1a73e8; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #1a1a2e; --fg: #e0e0e0; --card-bg: #16213e; --border: #2a2a4a; --accent: #64b5f6; --muted: #9e9e9e; --badge-bg: #1e3a5f; --badge-fg: #90caf9; }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; }
    .container { max-width: 860px; margin: 0 auto; padding: 2rem 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: var(--muted); margin-bottom: 1.5rem; }
    .filters { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1.5rem; }
    .filter-btn { background: var(--card-bg); border: 1px solid var(--border); border-radius: 1rem; padding: 0.3rem 0.8rem; cursor: pointer; font-size: 0.85rem; color: var(--fg); transition: all 0.15s; }
    .filter-btn:hover, .filter-btn.active { background: var(--badge-bg); color: var(--badge-fg); border-color: var(--accent); }
    .filter-btn .count { color: var(--muted); font-size: 0.75rem; }
    .timeline { list-style: none; border-left: 2px solid var(--border); padding-left: 1.5rem; }
    .timeline-item { position: relative; padding: 0.75rem 0; }
    .timeline-item::before { content: ""; position: absolute; left: -1.75rem; top: 1.1rem; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
    .timeline-item .time { font-size: 0.75rem; color: var(--muted); }
    .timeline-item .badge { display: inline-block; background: var(--badge-bg); color: var(--badge-fg); font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 0.75rem; margin-left: 0.5rem; }
    .timeline-item .title { font-weight: 500; margin-top: 0.15rem; }
    .timeline-item .details { font-size: 0.8rem; color: var(--muted); margin-top: 0.15rem; }
    .load-more { display: block; width: 100%; padding: 0.6rem; margin-top: 1rem; background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; cursor: pointer; color: var(--fg); font-size: 0.9rem; text-align: center; }
    .load-more:hover { background: var(--badge-bg); }
    .empty { text-align: center; color: var(--muted); padding: 3rem; }
    a.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
    a.back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <a class="back" href="/">&larr; Back to Wiki</a>
    <h1>Activity Log</h1>
    <p class="subtitle">${stats.total} total events</p>
    <div class="filters">
      <button class="filter-btn active" data-action="">All (${stats.total})</button>
      ${filterButtons}
    </div>
    <ul class="timeline" id="timeline"></ul>
    <button class="load-more" id="load-more">Load more</button>
    <div class="empty" id="empty" style="display:none;">No activity yet.</div>
  </div>
  <script>
    const authToken = document.querySelector('meta[name="kiwi-auth"]')?.content || '';
    const icons = ${JSON.stringify(actionIcons)};
    const labels = ${JSON.stringify(actionLabels)};
    let currentAction = '';
    let offset = 0;
    const limit = 50;

    function formatTime(iso) {
      const d = new Date(iso + 'Z');
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    }

    function renderEntry(e) {
      const icon = icons[e.action] || '📌';
      const label = labels[e.action] || e.action;
      let detailsHtml = '';
      if (e.details) {
        try {
          const d = JSON.parse(e.details);
          detailsHtml = '<span class="details">' + Object.entries(d).map(([k,v]) => k + ': ' + String(v).slice(0,60)).join(' | ') + '</span>';
        } catch {}
      }
      return '<li class="timeline-item" data-action="' + e.action + '">' +
        '<span class="time">' + formatTime(e.created_at) + '</span>' +
        '<span class="badge">' + icon + ' ' + label + '</span>' +
        '<div class="title">' + (e.title || '') + '</div>' +
        detailsHtml + '</li>';
    }

    async function loadEntries(append) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset), token: authToken });
      if (currentAction) params.set('action', currentAction);
      const res = await fetch('/api/activity?' + params);
      const entries = await res.json();
      const tl = document.getElementById('timeline');
      if (!append) tl.innerHTML = '';
      if (entries.length === 0 && offset === 0) {
        document.getElementById('empty').style.display = '';
        document.getElementById('load-more').style.display = 'none';
      } else {
        document.getElementById('empty').style.display = 'none';
        document.getElementById('load-more').style.display = entries.length < limit ? 'none' : '';
        tl.innerHTML += entries.map(renderEntry).join('');
      }
    }

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentAction = btn.dataset.action;
        offset = 0;
        loadEntries(false);
      });
    });

    document.getElementById('load-more').addEventListener('click', () => {
      offset += limit;
      loadEntries(true);
    });

    loadEntries(false);
  </script>
</body>
</html>`;
}
