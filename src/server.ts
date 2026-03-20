import { join } from "path";
import path from "path";
import crypto from "crypto";
import { DB_FILE, loadConfig, saveConfig, getActivePersona } from "./config";
import { Store } from "./store";
import type { KiwiConfig } from "./config";

export function startServer(root: string, port: number, host: string): void {
  const config = loadConfig(root);
  const siteDir = join(root, config.build.output_dir);

  let isProcessing = false;
  let processingStatus = "";

  const hostname = host;
  const authToken = crypto.randomUUID();
  console.log(`\x1b[32m🥝 Kiwi Mu 서버 시작!\x1b[0m`);
  console.log(`  http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
  console.log(`  관리 페이지: http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}/admin?token=${authToken}`);
  console.log(`  인증 토큰: ${authToken}`);
  if (hostname === "0.0.0.0") console.log("  네트워크에 공개됨 (0.0.0.0)");
  console.log("  웹에서 문서 추가 가능합니다.\n");

  Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);

      // ── Auth middleware for /api/* and /admin ──
      if (url.pathname.startsWith("/api/") || url.pathname === "/admin") {
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
        const supported = ["pdf", "docx", "doc", "pptx", "ppt", "key", "rtf"];
        if (!supported.includes(ext)) {
          return Response.json({ error: `지원하지 않는 형식: .${ext}. 지원: ${supported.join(", ")}` }, { status: 400 });
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
          const store = new Store(join(root, DB_FILE));
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
            store.close();
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
          const store = new Store(join(root, DB_FILE));
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
            store.close();
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
          const store = new Store(join(root, DB_FILE));
          try {
            const { buildSite } = await import("./build/renderer");
            await buildSite(store, currentConfig, root);
            console.log("\x1b[32m✅ 설정 변경 후 사이트 리빌드 완료\x1b[0m");
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`\x1b[31m❌ 리빌드 실패: ${message}\x1b[0m`);
          } finally {
            store.close();
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
          const store = new Store(join(root, DB_FILE));
          try {
            const { buildSite } = await import("./build/renderer");
            await buildSite(store, loadConfig(root), root);
            processingStatus = "빌드 완료!";
            console.log("\x1b[32m✅ 수동 빌드 완료\x1b[0m");
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            processingStatus = `빌드 오류: ${message}`;
          } finally {
            store.close();
            setTimeout(() => { isProcessing = false; }, 2000);
          }
        })();
        return Response.json({ ok: true, message: "빌드 시작" });
      }

      // Admin page
      if (url.pathname === "/admin") {
        const store = new Store(join(root, DB_FILE));
        const sources = store.listSourcesMeta();
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
          authToken,
        }), { headers: { "Content-Type": "text/html" } });
      }

      if (url.pathname === "/api/status") {
        const store = new Store(join(root, DB_FILE));
        const sources = store.listSourcesMeta();
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

      const resolved = path.resolve(join(siteDir, pathname));
      if (!resolved.startsWith(path.resolve(siteDir))) {
        return new Response("Forbidden", { status: 403 });
      }
      const staticFile = Bun.file(resolved);

      if (await staticFile.exists()) {
        const isHtml = pathname.endsWith(".html");
        const cspValue = "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net d3js.org; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net fonts.googleapis.com; font-src fonts.gstatic.com; img-src * data:; connect-src 'self'";
        if (isHtml) {
          return new Response(staticFile, { headers: { "Content-Type": "text/html", "Content-Security-Policy": cspValue } });
        }
        return new Response(staticFile);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
}
