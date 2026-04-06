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

              // Check auto_promote config
              const qaConfig = currentConfig.qa;
              if (qaConfig?.auto_promote && result.isPromotable) {
                // Auto-promote: create permanent wiki page with quizzes
                try {
                  const promoteResp = await fetch(`http://localhost:${port}/api/promote`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                    body: JSON.stringify({
                      question: autoQuestion,
                      answer: result.content,
                      title: result.suggestedTitle,
                      sourcePageId: parentPage.id,
                      selectedText: selected_text,
                    }),
                  });
                  const promoteData = await promoteResp.json() as Record<string, unknown>;
                  if (promoteData.ok) {
                    console.log(`\x1b[32m✅ Auto-promoted: ${result.title}\x1b[0m`);
                  }
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

          const sourcePage = store.listPages().find(p => p.id === body.sourcePageId);
          if (!sourcePage) {
            return Response.json({ error: "원본 페이지를 찾을 수 없습니다" }, { status: 404 });
          }

          // Deduplication: check if similar page already exists
          const existing = store.findSimilarPage(body.title);
          if (existing) {
            // Update existing page content instead of creating duplicate
            const updatedContent = existing.content + "\n\n---\n\n" + body.answer;
            store.updatePageContent(existing.id, updatedContent);

            // Hot-render updated page
            const { buildSinglePage } = await import("./build/renderer");
            await buildSinglePage(root, store, existing.slug);

            return Response.json({
              ok: true,
              slug: existing.slug,
              title: existing.title,
              url: `/wiki/${existing.slug}.html`,
              updated: true,
              message: "기존 페이지에 내용이 추가되었습니다",
            });
          }

          // Create new concept page from Q&A answer
          const { slugify } = await import("./pipeline/chunker");
          let slug = slugify(body.title);
          if (!slug) slug = slugify(body.question);
          if (!slug) slug = `qa-${Date.now()}`;

          let finalSlug = slug;
          let counter = 2;
          while (store.getPage(finalSlug)) {
            finalSlug = `${slug}-${counter++}`;
          }

          // Build page content with context
          let pageContent = body.answer;
          if (body.selectedText) {
            pageContent = `> ${body.selectedText.slice(0, 500)}\n\n${pageContent}`;
          }

          const page = store.addPage(finalSlug, body.title, pageContent, undefined, undefined, "concept", 0);

          // Mark as user-generated origin (addPage defaults to 'batch')
          const db = (store as any).db as import("bun:sqlite").Database;
          db.prepare("UPDATE pages SET origin = 'user', user_question = ?, parent_page_id = ? WHERE slug = ?")
            .run(body.question, body.sourcePageId, finalSlug);

          // Inject wiki links into the new page (targeted, not full re-link)
          const allPages = store.listPages();
          const targets = allPages
            .filter(p => p.id !== page.id && p.title.length >= 3)
            .sort((a, b) => b.title.length - a.title.length);

          let linkedContent = pageContent;
          const linkedSlugs = new Set<string>();
          for (const target of targets) {
            if (linkedSlugs.has(target.slug)) continue;
            const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const regex = new RegExp(`(?<!\\[)(?<!\\w)(${escaped})(?!\\w)(?!\\])`, "i");
            const match = regex.exec(linkedContent);
            if (match) {
              const replacement = `[${match[1]}](/wiki/${target.slug})`;
              linkedContent = linkedContent.slice(0, match.index) + replacement + linkedContent.slice(match.index + match[0].length);
              linkedSlugs.add(target.slug);
              store.addLink(page.id, target.id, match[1]);
            }
          }
          if (linkedSlugs.size > 0) {
            store.updatePageContent(page.id, linkedContent);
          }

          // Add link from source page to new page
          store.addLink(body.sourcePageId, page.id, body.title);

          // Generate 1-2 quizzes for the new concept
          try {
            const currentConfig = loadConfig(root);
            const { LLMClient } = await import("./llm-client");
            const llmClient = new LLMClient(currentConfig.llm);

            const quizSystem = `You are a quiz generator for a study wiki. Generate quiz questions that test UNDERSTANDING, not just memorization.
Focus on higher-order thinking: "왜?", "어떻게?", "비교하라", "설명하라" style questions.
Return valid JSON only. No markdown fences.`;

            const quizPrompt = `Based on this wiki content, generate 1-2 quiz questions that test UNDERSTANDING.
Types: "fill_blank" (빈칸 채우기), "ox" (OX 퀴즈 - true/false), "short_answer" (단답형)

Content title: ${body.title}
Content:
${body.answer.slice(0, 3000)}

Respond with a JSON array only:
[{"question": "...", "answer": "...", "explanation": "...", "type": "fill_blank"}]

Rules:
- For fill_blank: use ___ to mark the blank in the question
- For ox: question should be a statement, answer should be "O" or "X"
- For short_answer: question should be answerable in 1-3 words
- Include "explanation" field: a brief 1-2 sentence explanation of WHY the answer is correct`;

            const raw = await llmClient.chatComplete(quizSystem, quizPrompt, 2048);
            let cleaned = raw.replace(/^```json?\n?/m, "").replace(/\n?```\s*$/m, "").trim();
            const quizzes = JSON.parse(cleaned) as Array<{ question: string; answer: string; explanation?: string; type: string }>;

            for (const q of quizzes) {
              if (q.question && q.answer && q.type) {
                store.addQuiz(page.id, q.question, q.answer, q.type, q.explanation || "");
              }
            }
          } catch {
            // Quiz generation is non-critical; silently skip failures
            console.log(`\x1b[33m⚠ 프로모트 퀴즈 생성 실패\x1b[0m`);
          }

          // Hot-render the new page + re-render source page
          const { buildSinglePage } = await import("./build/renderer");
          await buildSinglePage(root, store, finalSlug);
          await buildSinglePage(root, store, sourcePage.slug);

          return Response.json({
            ok: true,
            slug: finalSlug,
            title: body.title,
            url: `/wiki/${finalSlug}.html`,
            updated: false,
            message: "새 위키 페이지가 생성되었습니다",
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
