import { loadConfig } from "../../config";
import { renderActivityPage } from "../../build/templates";
import type { ContentIndex } from "../../services/index-generator";
import type { RuntimeCoordinator } from "../../services/runtime-coordinator";
import type { SqliteDataVersion } from "../../services/runtime-state";
import { readJsonObject } from "../../services/server-guards";
import type { Store } from "../../store";
import { apiJson, htmlResponse, inputErrorResponse } from "../http";
import { serverDrainingResponse } from "../runtime";

export interface RequestIpServer {
  requestIP(req: Request): { address: string } | null;
}

export interface ReadRouteContext {
  root: string;
  config: ReturnType<typeof loadConfig>;
  store: Store;
  runtimeState: RuntimeCoordinator;
  contentDbRevision: SqliteDataVersion;
  cachedIndexes: Map<boolean, { data: ContentIndex; revision: number; dataVersion: number }>;
  contentLeaseResource: string;
  askRateLimit: number;
  askRateWindow: number;
  rateLimitKey(req: Request, server: RequestIpServer): string;
  canStartLongTask?(): boolean;
}

export async function handleReadRoutes(
  req: Request,
  url: URL,
  server: RequestIpServer,
  context: ReadRouteContext,
): Promise<Response | null> {
  const {
    root,
    config,
    store,
    runtimeState,
    contentDbRevision,
    cachedIndexes,
    contentLeaseResource,
    askRateLimit,
    askRateWindow,
    rateLimitKey,
  } = context;

  if (url.pathname.startsWith("/api/tasks/") && req.method === "GET") {
    const match = url.pathname.match(
      /^\/api\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
    );
    if (!match) return apiJson({ error: "작업을 찾을 수 없습니다" }, { status: 404 });
    const task = await runtimeState.getTask(match[1]);
    if (!task) return apiJson({ error: "작업을 찾을 수 없습니다" }, { status: 404 });
    return apiJson(task);
  }

  if (url.pathname === "/api/search" && req.method === "GET") {
    const query = url.searchParams.get("q")?.trim();
    if (!query || query.length < 2) {
      return apiJson({ results: [] });
    }
    if (query.length > 500) {
      return apiJson({ error: "q는 500자 이하여야 합니다" }, { status: 400 });
    }

    try {
      const searchConfig = loadConfig(root);
      const embeddingLlmConfig = searchConfig.embedding
        ? { ...searchConfig.llm, provider: searchConfig.embedding.provider, api_key: searchConfig.embedding.api_key }
        : searchConfig.llm;
      if (embeddingLlmConfig.api_key) {
        const { semanticSearch } = await import("../../services/embedding");
        const semanticResults = await semanticSearch(query, store, embeddingLlmConfig, 5);
        if (semanticResults.length > 0) {
          return apiJson({
            results: semanticResults.map(r => ({
              slug: r.slug,
              title: r.title,
              page_type: r.pageType,
              origin: r.origin,
              preview: "",
              similarity: r.similarity,
            })),
            method: "semantic",
          });
        }
      }
    } catch {
      // Fall through to FTS/LIKE search.
    }

    const results = store.searchPages(query, 5);
    return apiJson({ results, method: "fts" });
  }

  if (url.pathname === "/api/ask-wiki" && req.method === "POST") {
    try {
      const body = await readJsonObject(req);
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (!question) return apiJson({ error: "question이 필요합니다" }, { status: 400 });
      if (question.length > 2000) return apiJson({ error: "question은 2000자 이하여야 합니다" }, { status: 400 });
      if (context.canStartLongTask?.() === false) return serverDrainingResponse();

      const rateLimit = await runtimeState.consumeRateLimit(
        "ask",
        rateLimitKey(req, server),
        askRateLimit,
        askRateWindow,
      );
      if (!rateLimit.allowed) {
        return apiJson(
          {
            error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
            retry_after_seconds: rateLimit.retryAfterSeconds,
          },
          { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
        );
      }
      if (context.canStartLongTask?.() === false) return serverDrainingResponse();

      const currentConfig = loadConfig(root);
      const embConfig = currentConfig.embedding
        ? { ...currentConfig.llm, provider: currentConfig.embedding.provider, api_key: currentConfig.embedding.api_key }
        : currentConfig.llm;

      let llm: import("../../services/rag").ChatLike | null = null;
      if (currentConfig.llm.api_key && currentConfig.llm.provider !== "demo") {
        const { LLMClient } = await import("../../llm-client");
        llm = new LLMClient(currentConfig.llm);
      }

      const { askWiki } = await import("../../services/rag");
      const result = await askWiki(store, question, embConfig, llm);
      store.addActivityLog("ask_wiki", `Q: ${question.slice(0, 80)}`, "query", undefined, { method: result.method });
      return apiJson(result);
    } catch (e: unknown) {
      const inputResponse = inputErrorResponse(e);
      if (inputResponse) return inputResponse;
      const message = e instanceof Error ? e.message : String(e);
      return apiJson({ error: message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/lint" && req.method === "GET") {
    try {
      const { lintWiki } = await import("../../services/lint");
      const report = lintWiki(store, config.schema);
      return apiJson(report);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return apiJson({ error: message }, { status: 500 });
    }
  }

  if (url.pathname === "/api/index" && req.method === "GET") {
    const refresh = url.searchParams.get("refresh") === "true";
    const useLLM = url.searchParams.get("llm") === "true";
    const revision = store.getContentIndexRevision();
    const dataVersion = contentDbRevision.current();
    const cachedIndex = cachedIndexes.get(useLLM);

    if (!refresh && cachedIndex?.revision === revision && cachedIndex.dataVersion === dataVersion) {
      return apiJson(cachedIndex.data);
    }

    const { generateContentIndex } = await import("../../services/index-generator");
    const currentConfig = loadConfig(root);
    const indexData = await generateContentIndex(store, {
      useLLM,
      llmConfig: currentConfig.llm,
    });

    cachedIndexes.set(useLLM, { data: indexData, revision, dataVersion: contentDbRevision.current() });
    return apiJson(indexData);
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    const usage = store.getUsageSummary();
    const activeLease = await runtimeState.getActiveLease(contentLeaseResource);

    return apiJson({
      processing: activeLease !== null,
      processingStatus: activeLease?.status ?? "",
      sources: store.countSources(),
      sourcePages: store.countPagesByType("source"),
      conceptPages: store.countPagesByType("concept"),
      links: store.countLinks(),
      usage,
    });
  }

  if (url.pathname.match(/^\/api\/pages\/(\d+)\/citations$/) && req.method === "GET") {
    const pageId = parseInt(url.pathname.split("/")[3]);
    if (isNaN(pageId)) return apiJson({ error: "잘못된 ID입니다" }, { status: 400 });
    const citations = store.getCitationsForPage(pageId);
    return apiJson({ citations });
  }

  if (url.pathname.match(/^\/api\/sources\/(\d+)\/citations$/) && req.method === "GET") {
    const sourceId = parseInt(url.pathname.split("/")[3]);
    if (isNaN(sourceId)) return apiJson({ error: "잘못된 ID입니다" }, { status: 400 });
    const citations = store.getCitationsForSource(sourceId);
    return apiJson({ citations });
  }

  if (url.pathname === "/api/provenance" && req.method === "GET") {
    const coverage = store.getSourceCoverage();
    return apiJson({ coverage });
  }

  if (url.pathname.startsWith("/api/page/") && url.pathname !== "/api/page/edit" && req.method === "GET") {
    const slug = url.pathname.replace("/api/page/", "");
    let decodedSlug: string;
    try {
      decodedSlug = decodeURIComponent(slug);
    } catch {
      return apiJson({ error: "잘못 인코딩된 slug입니다" }, { status: 400 });
    }
    const page = store.getPage(decodedSlug);
    if (!page) return apiJson({ error: "찾을 수 없습니다" }, { status: 404 });
    const body: Record<string, unknown> = {
      slug: page.slug,
      title: page.title,
      content: page.content,
      origin: page.origin,
    };
    if (url.searchParams.get("format") === "html") {
      const { renderPageContent } = await import("../../build/renderer");
      const allSlugs = new Set(store.listPages().map(p => p.slug));
      body.html = await renderPageContent(page, allSlugs);
    }
    return apiJson(body);
  }

  if (url.pathname === "/api/activity" && req.method === "GET") {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50") || 50, 1), 200);
    const rawOffset = url.searchParams.get("offset") ?? "0";
    if (!/^-?\d+$/.test(rawOffset.trim())) {
      return apiJson({ error: "offset은 안전한 정수여야 합니다" }, { status: 400 });
    }
    const parsedOffset = Number(rawOffset);
    if (!Number.isSafeInteger(parsedOffset)) {
      return apiJson({ error: "offset은 안전한 정수여야 합니다" }, { status: 400 });
    }
    const offset = Math.max(parsedOffset, 0);
    const action = url.searchParams.get("action") || undefined;
    const entries = store.getActivityLog(limit, offset, action);
    const stats = store.getActivityStats();
    return apiJson({ entries, total: stats.total });
  }

  if (url.pathname === "/activity") {
    const stats = store.getActivityStats();
    const html = renderActivityPage(config.project.name, stats);
    return htmlResponse(html);
  }

  if (url.pathname === "/provenance") {
    const coverage = store.getSourceCoverage();
    const sources = store.listSourcesMeta();
    const conceptPages = store.listConceptPages();
    const sourcePages = store.listSourcePages();
    const configData = loadConfig(root);

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

    const { renderProvenancePage } = await import("../../build/templates");
    const html = renderProvenancePage({
      wikiName: configData.project.name,
      coverage: matrix,
      sourcePages: sourcePages.map(p => ({ slug: p.slug, title: p.title })),
      conceptPages: conceptPages.map(p => ({ slug: p.slug, title: p.title })),
    });
    return htmlResponse(html);
  }

  return null;
}
