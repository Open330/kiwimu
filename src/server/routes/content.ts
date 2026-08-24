import crypto from "crypto";
import { getActivePersona, loadConfig } from "../../config";
import { StaleContentFenceError } from "../../repositories/content-fence-repository";
import { readJsonObject } from "../../services/server-guards";
import type { RuntimeCoordinator } from "../../services/runtime-coordinator";
import type { Store } from "../../store";
import { apiJson, inputErrorResponse } from "../http";
import {
  LeaseOwnershipLostError,
  TaskOwnershipLostError,
  acquireContentLease,
  conflictResponse,
  keepTaskAlive,
  serverDrainingResponse,
  type LeaseHeartbeat,
  type TaskHeartbeat,
} from "../runtime";

export interface ContentRequestServer {
  requestIP(req: Request): { address: string } | null;
}

export interface ContentRouteContext {
  root: string;
  store: Store;
  runtimeState: RuntimeCoordinator;
  contentLeaseResource: string;
  leaseTtlMs: number;
  taskHeartbeatTtlMs: number;
  askRateLimit: number;
  askRateWindow: number;
  rateLimitKey(req: Request, server: ContentRequestServer): string;
  trackBackgroundTask?(completion: Promise<void>, onTimeout: () => Promise<void>): void;
  canStartLongTask?(): boolean;
}

const GENERATED_CITATION_REF = /[ \t]*<sup class="citation-ref"><a href="#cite-\d+" title="[^"]*">\[\d+\]<\/a><\/sup>/g;

function stripGeneratedCitationRefs(content: string): string {
  return content.replace(GENERATED_CITATION_REF, "");
}

export async function handleContentRoutes(
  req: Request,
  url: URL,
  server: ContentRequestServer,
  context: ContentRouteContext,
): Promise<Response | null> {
  const {
    root,
    store,
    runtimeState,
    contentLeaseResource,
    leaseTtlMs,
    taskHeartbeatTtlMs,
    askRateLimit,
    askRateWindow,
    rateLimitKey,
  } = context;

  if (url.pathname === "/api/ask" && req.method === "POST") {
    let untransferredHeartbeat: LeaseHeartbeat | null = null;
    let untransferredTaskHeartbeat: TaskHeartbeat | null = null;
    let untransferredTaskId: string | null = null;
    try {
      const body = await readJsonObject(req);
      const selectedText = typeof body.selected_text === "string" ? body.selected_text.trim() : "";
      const pageSlug = typeof body.page_slug === "string" ? body.page_slug.trim() : "";
      const question = typeof body.question === "string" ? body.question.trim() : "";

      if (!selectedText || !pageSlug) {
        return apiJson({ error: "selected_text와 page_slug가 필요합니다" }, { status: 400 });
      }
      if (selectedText.length > 10_000) {
        return apiJson({ error: "selected_text는 10000자 이하여야 합니다" }, { status: 400 });
      }
      if (question.length > 2_000 || pageSlug.length > 200) {
        return apiJson({ error: "question 또는 page_slug가 허용 길이를 초과합니다" }, { status: 400 });
      }

      const parentPage = store.getPage(pageSlug);
      if (!parentPage) {
        return apiJson({ error: "페이지를 찾을 수 없습니다" }, { status: 404 });
      }

      if (context.canStartLongTask?.() === false) return serverDrainingResponse();
      const contentAdmission = await acquireContentLease(
        runtimeState,
        store,
        contentLeaseResource,
        leaseTtlMs,
        "질문 페이지 생성 중...",
      );
      if (!contentAdmission.acquired) return conflictResponse(contentAdmission);
      if (context.canStartLongTask?.() === false) {
        await contentAdmission.heartbeat.stop();
        return serverDrainingResponse();
      }
      const contentHeartbeat = contentAdmission.heartbeat;
      untransferredHeartbeat = contentHeartbeat;

      const rateLimit = await runtimeState.consumeRateLimit(
        "ask",
        rateLimitKey(req, server),
        askRateLimit,
        askRateWindow,
      );
      if (!rateLimit.allowed) {
        await contentHeartbeat.stop();
        untransferredHeartbeat = null;
        return apiJson(
          {
            error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
            retry_after_seconds: rateLimit.retryAfterSeconds,
          },
          { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
        );
      }

      // Auto-generate question from selected text if not provided
      const autoQuestion = question || `"${selectedText.slice(0, 100)}" 개념을 자세히 설명해주세요`;

      // Run generation in background, return task ID immediately
      await contentHeartbeat.assertOwned();
      const contentFence = contentAdmission.fence;
      const taskId = crypto.randomUUID();
      await runtimeState.createTask(taskId, "dynamic-qa", taskHeartbeatTtlMs);
      const taskHeartbeat = keepTaskAlive(runtimeState, taskId, taskHeartbeatTtlMs);
      const operationController = new AbortController();
      untransferredTaskHeartbeat = taskHeartbeat;
      untransferredTaskId = taskId;

      const backgroundJob = store.runWithContentFence(contentFence, async () => {
        const assertJobOwned = async (): Promise<void> => {
          await taskHeartbeat.assertOwned();
          await contentHeartbeat.assertOwned();
        };
        try {
          await assertJobOwned();
          const currentConfig = loadConfig(root);
          const persona = getActivePersona(currentConfig);
          const { LLMClient } = await import("../../llm-client");
          const llmClient = new LLMClient(currentConfig.llm, { signal: operationController.signal });

          const { generateDynamicPage } = await import("../../services/dynamic-qa");
          await assertJobOwned();
          const result = await generateDynamicPage(store, llmClient, persona, parentPage, selectedText, autoQuestion);
          await assertJobOwned();

          // Hot-render the new page + re-render parent page
          const { buildSinglePage } = await import("../../build/renderer");
          await assertJobOwned();
          await buildSinglePage(root, store, result.slug, {
            beforePublish: assertJobOwned,
          });
          await assertJobOwned();
          await buildSinglePage(root, store, pageSlug, {
            beforePublish: assertJobOwned,
          });
          await assertJobOwned();

          // Check auto_promote config
          const qaConfig = currentConfig.qa;
          if (qaConfig?.auto_promote && result.isPromotable) {
            // Auto-promote: create permanent wiki page with quizzes
            try {
              const { promoteToWiki } = await import("../../services/promote");
              await assertJobOwned();
              const promoteResult = await promoteToWiki(store, {
                question: autoQuestion,
                answer: result.content,
                title: result.suggestedTitle,
                sourcePageId: parentPage.id,
                selectedText,
              }, currentConfig.llm, { signal: operationController.signal });
              await assertJobOwned();

              // Hot-render the promoted page
              await assertJobOwned();
              await buildSinglePage(root, store, promoteResult.slug, {
                beforePublish: assertJobOwned,
              });
              await assertJobOwned();

              console.log(`\x1b[32m✅ Auto-promoted: ${result.title}\x1b[0m`);
            } catch (promoteErr) {
              if (
                promoteErr instanceof LeaseOwnershipLostError ||
                promoteErr instanceof TaskOwnershipLostError
              ) throw promoteErr;
              console.log(`\x1b[33m⚠ Auto-promote failed: ${promoteErr}\x1b[0m`);
            }
          }

          await assertJobOwned();
          const completed = await runtimeState.completeTask(taskId, {
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
            selectedText,
          });
          if (!completed) {
            throw new TaskOwnershipLostError(taskId, "completion rejected");
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          try {
            const failed = await runtimeState.failTask(taskId, message);
            if (!failed) {
              console.error(`\x1b[31m❌ 작업 상태 소유권 상실: ${message}\x1b[0m`);
            }
          } catch (statusError) {
            console.error(
              `\x1b[31m❌ 작업 실패 상태 저장 불가: ${statusError instanceof Error ? statusError.message : String(statusError)}\x1b[0m`,
            );
          }
        } finally {
          taskHeartbeat.stop();
          await contentHeartbeat.stop();
        }
      });
      const completion = Promise.resolve(backgroundJob).catch((error) => {
        console.error(`\x1b[31m❌ 질문 백그라운드 작업 실패: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
      });
      context.trackBackgroundTask?.(completion, async () => {
        const reason = "Server shutdown drain timed out before this task completed";
        operationController.abort(new Error(reason));
        taskHeartbeat.interrupt(reason);
        await Promise.allSettled([
          runtimeState.failTask(taskId, reason),
          contentHeartbeat.stop(),
        ]);
      });
      void completion;
      untransferredTaskHeartbeat = null;
      untransferredTaskId = null;
      untransferredHeartbeat = null;

      return apiJson({ task_id: taskId, message: "생성 시작" }, { status: 202 });
    } catch (e: unknown) {
      untransferredTaskHeartbeat?.stop();
      if (untransferredTaskId) {
        const message = e instanceof Error ? e.message : String(e);
        try {
          await runtimeState.failTask(untransferredTaskId, message);
        } catch {
          // The original admission/scheduling error is returned below.
        }
      }
      await untransferredHeartbeat?.stop();
      if (e instanceof StaleContentFenceError) {
        return apiJson({ error: "콘텐츠 쓰기 소유권을 확인하지 못했습니다. 잠시 후 다시 시도해주세요." }, { status: 503 });
      }
      const inputResponse = inputErrorResponse(e);
      if (inputResponse) return inputResponse;
      const message = e instanceof Error ? e.message : String(e);
      return apiJson({ error: message }, { status: 500 });
    }
  }

  // Background task status polling for dynamic Q&A
  if (url.pathname === "/api/ask/status" && req.method === "GET") {
    const taskId = url.searchParams.get("task_id");
    if (!taskId) {
      return apiJson({ error: "task_id가 필요합니다" }, { status: 400 });
    }
    const task = await runtimeState.getTask(taskId);
    if (!task) {
      return apiJson({ error: "작업을 찾을 수 없습니다" }, { status: 404 });
    }
    return apiJson(task);
  }

  // ── Promote Q&A answer to permanent wiki page ──
  if (url.pathname === "/api/promote" && req.method === "POST") {
    let contentHeartbeat: LeaseHeartbeat | null = null;
    try {
      const rawBody = await readJsonObject(req);
      if (
        typeof rawBody.question !== "string" ||
        typeof rawBody.answer !== "string" ||
        typeof rawBody.title !== "string" ||
        !Number.isInteger(rawBody.sourcePageId) ||
        (rawBody.selectedText !== undefined && typeof rawBody.selectedText !== "string")
      ) {
        return apiJson({ error: "question, answer, title, sourcePageId가 필요합니다" }, { status: 400 });
      }
      const body = {
        question: rawBody.question.trim(),
        answer: rawBody.answer.trim(),
        title: rawBody.title.trim(),
        sourcePageId: rawBody.sourcePageId as number,
        selectedText: rawBody.selectedText as string | undefined,
      };
      if (!body.question || !body.answer || !body.title || body.sourcePageId <= 0) {
        return apiJson({ error: "question, answer, title, sourcePageId가 필요합니다" }, { status: 400 });
      }

      if (body.title.length > 200) {
        return apiJson({ error: "title은 200자 이하여야 합니다" }, { status: 400 });
      }
      if (body.question.length > 2000) {
        return apiJson({ error: "question은 2000자 이하여야 합니다" }, { status: 400 });
      }
      if (body.answer.length > 50000) {
        return apiJson({ error: "answer는 50000자 이하여야 합니다" }, { status: 400 });
      }
      if (body.selectedText && body.selectedText.length > 10_000) {
        return apiJson({ error: "selectedText는 10000자 이하여야 합니다" }, { status: 400 });
      }

      const sourcePage = store.getPageById(body.sourcePageId);
      if (!sourcePage) {
        return apiJson({ error: "원본 페이지를 찾을 수 없습니다" }, { status: 404 });
      }

      if (context.canStartLongTask?.() === false) return serverDrainingResponse();
      const contentAdmission = await acquireContentLease(
        runtimeState,
        store,
        contentLeaseResource,
        leaseTtlMs,
        "질문 답변을 위키로 저장 중...",
      );
      if (!contentAdmission.acquired) return conflictResponse(contentAdmission);
      if (context.canStartLongTask?.() === false) {
        await contentAdmission.heartbeat.stop();
        return serverDrainingResponse();
      }
      contentHeartbeat = contentAdmission.heartbeat;
      const contentFence = contentAdmission.fence;

      const result = await store.runWithContentFence(contentFence, async () => {
        const currentConfig = loadConfig(root);
        const { promoteToWiki } = await import("../../services/promote");
        await contentHeartbeat!.assertOwned();
        const promoteResult = await promoteToWiki(store, body, currentConfig.llm);
        await contentHeartbeat!.assertOwned();

        // Hot-render the affected pages
        const { buildSinglePage } = await import("../../build/renderer");
        await contentHeartbeat!.assertOwned();
        await buildSinglePage(root, store, promoteResult.slug, {
          beforePublish: () => contentHeartbeat!.assertOwned(),
        });
        await contentHeartbeat!.assertOwned();
        await buildSinglePage(root, store, sourcePage.slug, {
          beforePublish: () => contentHeartbeat!.assertOwned(),
        });
        await contentHeartbeat!.assertOwned();
        return promoteResult;
      });

      return apiJson({
        ok: true,
        slug: result.slug,
        title: result.title,
        url: `/wiki/${result.slug}.html`,
        updated: !result.isNew,
        message: result.isNew ? "새 위키 페이지가 생성되었습니다" : "기존 페이지에 내용이 추가되었습니다",
      });
    } catch (e: unknown) {
      if (e instanceof StaleContentFenceError || e instanceof LeaseOwnershipLostError) {
        return apiJson({ error: "콘텐츠 쓰기 소유권을 확인하지 못했습니다. 잠시 후 다시 시도해주세요." }, { status: 503 });
      }
      const inputResponse = inputErrorResponse(e);
      if (inputResponse) return inputResponse;
      const message = e instanceof Error ? e.message : String(e);
      return apiJson({ error: message }, { status: 500 });
    } finally {
      await contentHeartbeat?.stop();
    }
  }

  // Page edit endpoint
  if (url.pathname === "/api/page/edit" && req.method === "POST") {
    let contentHeartbeat: LeaseHeartbeat | null = null;
    try {
      const body = await readJsonObject(req, 512 * 1024);
      const slug = typeof body.slug === "string" ? body.slug.trim() : "";
      const content = typeof body.content === "string" ? body.content : "";
      if (!slug || !content) {
        return apiJson({ error: "slug과 content가 필요합니다" }, { status: 400 });
      }
      if (slug.length > 200 || content.length > 500_000) {
        return apiJson({ error: "slug 또는 content가 허용 길이를 초과합니다" }, { status: 400 });
      }

      const page = store.getPage(slug);
      if (!page) {
        return apiJson({ error: "페이지를 찾을 수 없습니다" }, { status: 404 });
      }

      if (context.canStartLongTask?.() === false) return serverDrainingResponse();
      const contentAdmission = await acquireContentLease(
        runtimeState,
        store,
        contentLeaseResource,
        leaseTtlMs,
        "페이지 편집 반영 중...",
      );
      if (!contentAdmission.acquired) {
        return conflictResponse(contentAdmission, "처리 중에는 페이지를 편집할 수 없습니다");
      }
      if (context.canStartLongTask?.() === false) {
        await contentAdmission.heartbeat.stop();
        return serverDrainingResponse();
      }
      contentHeartbeat = contentAdmission.heartbeat;
      const contentFence = contentAdmission.fence;
      // Re-read after admission: another owner may have completed an edit
      // between the optimistic existence check and this lease acquisition.
      const admittedPage = store.getPage(slug);
      if (!admittedPage) {
        return apiJson({ error: "페이지를 찾을 수 없습니다" }, { status: 404 });
      }
      const contentChanged = content !== admittedPage.content;
      const candidateContent = contentChanged ? stripGeneratedCitationRefs(content) : content;
      const candidateCitations = contentChanged
        ? []
        : store.getCitationsForPage(admittedPage.id);

      await store.runWithContentFence(contentFence, async () => {
        await contentHeartbeat!.assertOwned();
        const { buildSinglePage } = await import("../../build/renderer");
        await buildSinglePage(root, store, slug, {
          candidate: {
            page: { ...admittedPage, content: candidateContent },
            citations: candidateCitations,
          },
          beforePublish: () => contentHeartbeat!.assertOwned(),
          ...(contentChanged ? {
            commitCandidate: () => {
              // A real manual edit invalidates generated provenance. The DB
              // mutation and staged files share one fenced transaction.
              store.updatePageContentAndCitationsBySlugAsManualEdit(slug, candidateContent, []);
            },
          } : {}),
        });
      });

      return apiJson({ ok: true, slug });
    } catch (e: unknown) {
      if (e instanceof StaleContentFenceError || e instanceof LeaseOwnershipLostError) {
        return apiJson({ error: "콘텐츠 쓰기 소유권을 확인하지 못했습니다. 잠시 후 다시 시도해주세요." }, { status: 503 });
      }
      const inputResponse = inputErrorResponse(e);
      if (inputResponse) return inputResponse;
      const message = e instanceof Error ? e.message : String(e);
      return apiJson({ error: message }, { status: 500 });
    } finally {
      await contentHeartbeat?.stop();
    }
  }

  return null;
}
