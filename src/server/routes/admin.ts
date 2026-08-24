import { loadConfig, saveConfig } from "../../config";
import { StaleContentFenceError } from "../../repositories/content-fence-repository";
import type { ContentIndex } from "../../services/index-generator";
import type { RuntimeCoordinator } from "../../services/runtime-coordinator";
import { readJsonObject } from "../../services/server-guards";
import type { Store } from "../../store";
import { apiJson, htmlResponse, inputErrorResponse } from "../http";
import {
  acquireContentLease,
  conflictResponse,
  serverDrainingResponse,
  startTrackedContentJob,
  type LeaseHeartbeat,
} from "../runtime";

type KiwiConfig = ReturnType<typeof loadConfig>;
const SUPPORTED_LLM_PROVIDERS = new Set(["gemini", "azure-openai", "openai", "anthropic"]);

function isOfficialAzureOpenAiEndpoint(value: string): boolean {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return false;
  }
  const hostname = endpoint.hostname.toLowerCase();
  return endpoint.protocol === "https:" &&
    endpoint.username === "" &&
    endpoint.password === "" &&
    endpoint.port === "" &&
    hostname !== "openai.azure.com" &&
    hostname.endsWith(".openai.azure.com");
}

function detachedJobStartErrorResponse(error: unknown): Response {
  if (error instanceof StaleContentFenceError) {
    return apiJson({ error: "콘텐츠 쓰기 소유권을 확인하지 못했습니다. 잠시 후 다시 시도해주세요." }, { status: 503 });
  }
  return apiJson(
    { error: error instanceof Error ? error.message : "백그라운드 작업을 시작하지 못했습니다" },
    { status: 500 },
  );
}

export interface AdminRouteContext {
  root: string;
  config: KiwiConfig;
  store: Store;
  runtimeState: RuntimeCoordinator;
  cachedIndexes: Map<boolean, { data: ContentIndex; revision: number; dataVersion: number }>;
  contentLeaseResource: string;
  leaseTtlMs: number;
  taskHeartbeatTtlMs: number;
  supportedUploadExtensions: readonly string[];
  trackBackgroundTask?(completion: Promise<void>, onTimeout: () => Promise<void>): void;
  canStartLongTask?(): boolean;
}

export async function handleAdminRoutes(
  req: Request,
  url: URL,
  context: AdminRouteContext,
): Promise<Response | null> {
  const {
    root,
    config,
    store,
    runtimeState,
    cachedIndexes,
    contentLeaseResource,
    leaseTtlMs,
    taskHeartbeatTtlMs,
  } = context;

  if (url.pathname === "/api/settings" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (error) {
      return inputErrorResponse(error) ?? apiJson({ error: "요청을 읽지 못했습니다" }, { status: 400 });
    }
    for (const key of ["wiki_name", "provider", "model", "api_key", "endpoint"] as const) {
      if (body[key] !== undefined && typeof body[key] !== "string") {
        return apiJson({ error: `${key}는 문자열이어야 합니다` }, { status: 400 });
      }
    }
    if (typeof body.wiki_name === "string" && body.wiki_name.trim().length > 120) {
      return apiJson({ error: "wiki_name은 120자 이하여야 합니다" }, { status: 400 });
    }
    if (typeof body.provider === "string" && body.provider.length > 64) {
      return apiJson({ error: "provider는 64자 이하여야 합니다" }, { status: 400 });
    }
    if (typeof body.model === "string" && body.model.length > 200) {
      return apiJson({ error: "model은 200자 이하여야 합니다" }, { status: 400 });
    }
    if (typeof body.endpoint === "string" && body.endpoint.length > 4096) {
      return apiJson({ error: "endpoint는 4096자 이하여야 합니다" }, { status: 400 });
    }
    const requestedProvider = typeof body.provider === "string" ? body.provider.trim() : undefined;
    const requestedEndpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : undefined;
    if (requestedProvider !== undefined && !SUPPORTED_LLM_PROVIDERS.has(requestedProvider)) {
      return apiJson({ error: "지원하지 않는 provider입니다" }, { status: 400 });
    }
    if (requestedEndpoint && !isOfficialAzureOpenAiEndpoint(requestedEndpoint)) {
      return apiJson(
        { error: "endpoint는 공식 Azure OpenAI HTTPS 주소(*.openai.azure.com)여야 합니다" },
        { status: 400 },
      );
    }
    if (requestedProvider !== undefined || requestedEndpoint !== undefined) {
      const existingLlm = loadConfig(root).llm;
      const effectiveProvider = requestedProvider ?? existingLlm.provider;
      const effectiveEndpoint = requestedEndpoint ?? existingLlm.endpoint.trim();
      if (
        effectiveProvider === "azure-openai" &&
        (!effectiveEndpoint || !isOfficialAzureOpenAiEndpoint(effectiveEndpoint))
      ) {
        return apiJson(
          { error: "Azure OpenAI provider에는 공식 HTTPS endpoint가 필요합니다" },
          { status: 400 },
        );
      }
    }

    if (context.canStartLongTask?.() === false) return serverDrainingResponse();
    const contentAdmission = await acquireContentLease(
      runtimeState,
      store,
      contentLeaseResource,
      leaseTtlMs,
      "설정 적용 후 빌드 중...",
    );
    if (!contentAdmission.acquired) return conflictResponse(contentAdmission);
    if (context.canStartLongTask?.() === false) {
      await contentAdmission.heartbeat.stop();
      return serverDrainingResponse();
    }
    const contentLease = contentAdmission.lease;
    const contentHeartbeat = contentAdmission.heartbeat;
    const contentFence = contentAdmission.fence;

    let currentConfig: KiwiConfig;
    try {
      await contentHeartbeat.assertOwned();
      currentConfig = loadConfig(root);
      if (typeof body.wiki_name === "string" && body.wiki_name.trim()) currentConfig.project.name = body.wiki_name.trim();
      if (typeof body.provider === "string" && body.provider.trim()) currentConfig.llm.provider = body.provider.trim();
      if (typeof body.model === "string" && body.model.trim()) currentConfig.llm.model = body.model.trim();
      if (typeof body.api_key === "string") currentConfig.llm.api_key = body.api_key;
      if (typeof body.endpoint === "string") currentConfig.llm.endpoint = body.endpoint.trim();
      await contentHeartbeat.assertOwned();
      store.runWithContentFence(contentFence, () => {
        store.publishContent(() => saveConfig(root, currentConfig));
      });
      await contentHeartbeat.assertOwned();
      Object.assign(config, currentConfig);
      cachedIndexes.delete(true);
    } catch (error) {
      await contentHeartbeat.stop();
      return apiJson(
        { error: error instanceof Error ? error.message : "설정을 저장하지 못했습니다" },
        { status: 500 },
      );
    }

    let taskId: string;
    try {
      const trackedJob = await startTrackedContentJob({
        runtimeState,
        store,
        fence: contentFence,
        contentHeartbeat,
        taskKind: "settings-rebuild",
        taskHeartbeatTtlMs,
        operation: async ({ assertOwned }) => {
          await assertOwned();
          const { buildSite } = await import("../../build/renderer");
          await buildSite(store, currentConfig, root, {
            beforePublish: assertOwned,
          });
          await assertOwned();
          console.log("\x1b[32m✅ 설정 변경 후 사이트 리빌드 완료\x1b[0m");
        },
        reportError(error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`\x1b[31m❌ 리빌드 실패: ${message}\x1b[0m`);
        },
      });
      taskId = trackedJob.taskId;
      context.trackBackgroundTask?.(
        trackedJob.completion,
        () => trackedJob.interrupt("Server shutdown drain timed out before this task completed"),
      );
    } catch (error) {
      return detachedJobStartErrorResponse(error);
    }

    return apiJson({ ok: true, task_id: taskId });
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    const currentConfig = loadConfig(root);
    const masked = { ...currentConfig.llm, api_key: currentConfig.llm.api_key ? "••••" + currentConfig.llm.api_key.slice(-4) : "" };
    return apiJson(masked);
  }

  if (url.pathname === "/api/personas" && req.method === "GET") {
    const currentConfig = loadConfig(root);
    return apiJson({
      personas: currentConfig.personas || [],
      active: currentConfig.active_persona || "",
    });
  }

  if (url.pathname === "/api/personas" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (error) {
      return inputErrorResponse(error) ?? apiJson({ error: "요청을 읽지 못했습니다" }, { status: 400 });
    }
    const readPersona = (): { name: string; description: string; system_prompt: string; content_style: string } | null => {
      if (body.persona === null || Array.isArray(body.persona) || typeof body.persona !== "object") return null;
      const value = body.persona as Record<string, unknown>;
      if (typeof value.name !== "string") return null;
      for (const key of ["description", "system_prompt", "content_style"] as const) {
        if (value[key] !== undefined && typeof value[key] !== "string") return null;
      }
      return {
        name: value.name.trim(),
        description: (value.description as string | undefined) ?? "",
        system_prompt: (value.system_prompt as string | undefined) ?? "",
        content_style: (value.content_style as string | undefined) ?? "",
      };
    };

    if (context.canStartLongTask?.() === false) return serverDrainingResponse();
    const personaAdmission = await acquireContentLease(
      runtimeState,
      store,
      contentLeaseResource,
      leaseTtlMs,
      "페르소나 설정 저장 중...",
    );
    if (!personaAdmission.acquired) return conflictResponse(personaAdmission);
    if (context.canStartLongTask?.() === false) {
      await personaAdmission.heartbeat.stop();
      return serverDrainingResponse();
    }
    let personaHeartbeat: LeaseHeartbeat | null = personaAdmission.heartbeat;
    const personaFence = personaAdmission.fence;

    try {
      await personaHeartbeat.assertOwned();
      const currentConfig = loadConfig(root);
      if (!currentConfig.personas) currentConfig.personas = [];

      if (body.action === "add") {
        const persona = readPersona();
        if (!persona) return apiJson({ error: "올바른 persona 객체가 필요합니다" }, { status: 400 });
        const { name, description, system_prompt, content_style } = persona;
        if (!name) return apiJson({ error: "이름이 필요합니다" }, { status: 400 });
        if (name.length > 80 || description.length > 500 || system_prompt.length > 20_000 || content_style.length > 10_000) {
          return apiJson({ error: "페르소나 입력이 허용 길이를 초과합니다" }, { status: 400 });
        }
        if (currentConfig.personas.find(p => p.name === name)) {
          return apiJson({ error: "이미 존재하는 페르소나입니다" }, { status: 409 });
        }
        currentConfig.personas.push({ name, description, system_prompt, content_style });
      } else if (body.action === "update") {
        const originalName = typeof body.original_name === "string" ? body.original_name : "";
        const persona = readPersona();
        if (!originalName || !persona?.name) return apiJson({ error: "original_name과 persona가 필요합니다" }, { status: 400 });
        if (persona.name.length > 80 || persona.description.length > 500 || persona.system_prompt.length > 20_000 || persona.content_style.length > 10_000) {
          return apiJson({ error: "페르소나 입력이 허용 길이를 초과합니다" }, { status: 400 });
        }
        const idx = currentConfig.personas.findIndex(p => p.name === originalName);
        if (idx === -1) return apiJson({ error: "페르소나를 찾을 수 없습니다" }, { status: 404 });
        if (persona.name !== originalName && currentConfig.personas.some(p => p.name === persona.name)) {
          return apiJson({ error: "이미 존재하는 페르소나입니다" }, { status: 409 });
        }
        currentConfig.personas[idx] = persona;
        if (currentConfig.active_persona === originalName && persona.name !== originalName) {
          currentConfig.active_persona = persona.name;
        }
      } else if (body.action === "delete") {
        const name = typeof body.name === "string" ? body.name : "";
        if (!name) return apiJson({ error: "name이 필요합니다" }, { status: 400 });
        if (!currentConfig.personas.some(p => p.name === name)) {
          return apiJson({ error: "페르소나를 찾을 수 없습니다" }, { status: 404 });
        }
        currentConfig.personas = currentConfig.personas.filter(p => p.name !== name);
        if (currentConfig.active_persona === name) {
          currentConfig.active_persona = currentConfig.personas[0]?.name || "";
        }
      } else if (body.action === "activate") {
        const name = typeof body.name === "string" ? body.name : "";
        if (name && !currentConfig.personas.find(p => p.name === name)) {
          return apiJson({ error: "페르소나를 찾을 수 없습니다" }, { status: 404 });
        }
        currentConfig.active_persona = name;
      } else {
        return apiJson({ error: "지원하지 않는 action입니다" }, { status: 400 });
      }

      await personaHeartbeat.assertOwned();
      store.runWithContentFence(personaFence, () => {
        store.publishContent(() => saveConfig(root, currentConfig));
      });
      await personaHeartbeat.assertOwned();
      Object.assign(config, currentConfig);
      return apiJson({ ok: true, personas: currentConfig.personas, active: currentConfig.active_persona });
    } finally {
      await personaHeartbeat?.stop();
      personaHeartbeat = null;
    }
  }

  if (url.pathname === "/api/build" && req.method === "POST") {
    if (context.canStartLongTask?.() === false) return serverDrainingResponse();
    const contentAdmission = await acquireContentLease(
      runtimeState,
      store,
      contentLeaseResource,
      leaseTtlMs,
      "빌드 중...",
    );
    if (!contentAdmission.acquired) return conflictResponse(contentAdmission);
    if (context.canStartLongTask?.() === false) {
      await contentAdmission.heartbeat.stop();
      return serverDrainingResponse();
    }
    const contentHeartbeat = contentAdmission.heartbeat;
    const contentFence = contentAdmission.fence;
    let taskId: string;
    try {
      const trackedJob = await startTrackedContentJob({
        runtimeState,
        store,
        fence: contentFence,
        contentHeartbeat,
        taskKind: "site-build",
        taskHeartbeatTtlMs,
        operation: async ({ assertOwned }) => {
          await assertOwned();
          const { buildSite } = await import("../../build/renderer");
          await buildSite(store, loadConfig(root), root, {
            beforePublish: assertOwned,
          });
          await assertOwned();
          console.log("\x1b[32m✅ 수동 빌드 완료\x1b[0m");
        },
        reportError(error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`\x1b[31m❌ 수동 빌드 실패: ${message}\x1b[0m`);
        },
      });
      taskId = trackedJob.taskId;
      context.trackBackgroundTask?.(
        trackedJob.completion,
        () => trackedJob.interrupt("Server shutdown drain timed out before this task completed"),
      );
    } catch (error) {
      return detachedJobStartErrorResponse(error);
    }
    return apiJson({ ok: true, message: "빌드 시작", task_id: taskId }, { status: 202 });
  }

  if (url.pathname === "/manage") {
    const sources = store.listSourcesMeta();
    const usage = store.getUsageSummary();
    const configData = loadConfig(root);

    const { renderAdmin } = await import("../../build/templates");
    const html = renderAdmin({
      wikiName: configData.project.name,
      sources,
      usage,
      llmConfig: configData.llm,
      personas: configData.personas || [],
      activePersona: configData.active_persona || "",
      supportedUploadExtensions: context.supportedUploadExtensions,
    });
    return htmlResponse(html);
  }

  return null;
}
