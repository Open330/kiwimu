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

  const askRateLimit = new Map<string, number[]>(); // ip -> timestamps
  const ASK_RATE_LIMIT = 10; // max requests
  const ASK_RATE_WINDOW = 60_000; // per minute

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

          if (!selected_text || !question || !page_slug) {
            return Response.json({ error: "선택한 텍스트와 질문을 모두 입력해주세요" }, { status: 400 });
          }

          const parentPage = store.getPage(page_slug);
          if (!parentPage) {
            return Response.json({ error: "페이지를 찾을 수 없습니다" }, { status: 404 });
          }

          const currentConfig = loadConfig(root);
          const persona = getActivePersona(currentConfig);
          const { LLMClient } = await import("./llm-client");
          const llmClient = new LLMClient(currentConfig.llm);

          const { generateDynamicPage } = await import("./services/dynamic-qa");
          const result = await generateDynamicPage(store, llmClient, persona, parentPage, selected_text, question);

          // Hot-render the new page
          const { buildSinglePage } = await import("./build/renderer");
          await buildSinglePage(root, store, result.slug);

          return Response.json({
            ok: true,
            slug: result.slug,
            title: result.title,
            url: `/wiki/${result.slug}.html`
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return Response.json({ error: message }, { status: 500 });
        }
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
