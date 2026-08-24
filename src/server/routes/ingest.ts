import path, { join } from "path";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { getActivePersona, loadConfig } from "../../config";
import {
  detectServerUploadCapabilities,
  normalizeUploadExtension,
  unsupportedServerUploadMessage,
  UPLOAD_EXTENSION_HEADER,
  type ServerUploadCapabilities,
} from "../../ingest/capabilities";
import { StaleContentFenceError } from "../../repositories/content-fence-repository";
import type { Store } from "../../store";
import { readJsonObject, validateUploadEnvelope } from "../../services/server-guards";
import type { RuntimeCoordinator } from "../../services/runtime-coordinator";
import type { RuntimeLease } from "../../services/runtime-state";
import { apiJson, inputErrorResponse } from "../http";
import {
  LeaseOwnershipLostError,
  acquireContentLease,
  conflictResponse,
  keepLeaseAlive,
  serverDrainingResponse,
  startTrackedContentJob,
  type LeaseHeartbeat,
  uploadBusyResponse,
} from "../runtime";

function detachedJobStartErrorResponse(error: unknown): Response {
  if (error instanceof StaleContentFenceError) {
    return apiJson({ error: "콘텐츠 쓰기 소유권을 확인하지 못했습니다. 잠시 후 다시 시도해주세요." }, { status: 503 });
  }
  return apiJson({ error: "백그라운드 작업을 시작하지 못했습니다" }, { status: 500 });
}

/**
 * Reserve a unique directory for one upload and retain the user-facing basename.
 * Exclusive directory creation makes the resulting path immutable: an existing
 * upload is never selected as the destination of a later request.
 */
export function reserveImmutableUploadPath(root: string, originalName: string): string {
  const basename = path.basename(originalName);
  if (!basename || basename === "." || basename === "..") {
    throw new TypeError("올바른 파일 이름이 필요합니다");
  }
  const uploadRoot = join(root, "uploads");
  if (existsSync(uploadRoot)) {
    const metadata = lstatSync(uploadRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Unsafe upload root: ${uploadRoot}`);
    }
  } else {
    mkdirSync(uploadRoot, { mode: 0o700 });
  }
  const uploadRootDescriptor = openSync(
    uploadRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fstatSync(uploadRootDescriptor).isDirectory()) {
      throw new Error(`Unsafe upload root: ${uploadRoot}`);
    }
    fchmodSync(uploadRootDescriptor, 0o700);
  } finally {
    closeSync(uploadRootDescriptor);
  }
  const uploadDirectory = join(uploadRoot, randomUUID());
  mkdirSync(uploadDirectory, { mode: 0o700 });
  const uploadDescriptor = openSync(
    uploadDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fstatSync(uploadDescriptor).isDirectory()) {
      throw new Error(`Unsafe upload directory: ${uploadDirectory}`);
    }
    fchmodSync(uploadDescriptor, 0o700);
  } finally {
    closeSync(uploadDescriptor);
  }
  return join(uploadDirectory, basename);
}

/** Remove only a KiwiMu-reserved upload that never became a live Source. */
export function cleanupUnpublishedUpload(root: string, store: Pick<Store, "getSource">, filePath: string): boolean {
  if (typeof store.getSource !== "function") return false;
  if (store.getSource(filePath)) return false;
  const uploadRoot = path.resolve(root, "uploads");
  const uploadDirectory = path.dirname(path.resolve(filePath));
  if (
    path.dirname(uploadDirectory) !== uploadRoot ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path.basename(uploadDirectory))
  ) {
    return false;
  }
  if (!existsSync(uploadDirectory)) return false;
  const metadata = lstatSync(uploadDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
  rmSync(uploadDirectory, { recursive: true, force: true });
  if (existsSync(uploadRoot)) {
    const rootMetadata = lstatSync(uploadRoot);
    if (!rootMetadata.isSymbolicLink() && rootMetadata.isDirectory() && readdirSync(uploadRoot).length === 0) {
      rmdirSync(uploadRoot);
    }
  }
  return true;
}

/** Write one reserved upload without retaining a partial or broadly-readable file. */
export async function writePrivateUploadFile(filePath: string, file: Blob): Promise<void> {
  try {
    await Bun.write(filePath, file);
    chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Cleanup must not hide the original write or permission error.
    }
    throw error;
  }
}

export interface IngestRouteContext {
  root: string;
  store: Store;
  runtimeState: RuntimeCoordinator;
  contentLeaseResource: string;
  uploadLeaseResource: string;
  leaseTtlMs: number;
  taskHeartbeatTtlMs: number;
  uploadConcurrency: number;
  maxUploadSize: number;
  maxUploadBodySize: number;
  uploadCapabilities: ServerUploadCapabilities;
  updateOwnedLeaseStatus(heartbeat: LeaseHeartbeat, lease: RuntimeLease, status: string): Promise<void>;
  trackBackgroundTask?(completion: Promise<void>, onTimeout: () => Promise<void>): void;
  canStartLongTask?(): boolean;
}

export async function handleIngestRoutes(
  req: Request,
  url: URL,
  context: IngestRouteContext,
): Promise<Response | null> {
  const {
    root,
    store,
    runtimeState,
    contentLeaseResource,
    uploadLeaseResource,
    leaseTtlMs,
    taskHeartbeatTtlMs,
    uploadConcurrency,
    maxUploadSize,
    maxUploadBodySize,
    updateOwnedLeaseStatus,
  } = context;
  const uploadCapabilities = context.uploadCapabilities ?? detectServerUploadCapabilities();

  if (url.pathname === "/api/upload" && req.method === "POST") {
    try {
      validateUploadEnvelope(req, maxUploadBodySize);
    } catch (error) {
      return inputErrorResponse(error) ?? apiJson({ error: "올바른 multipart/form-data 요청이 필요합니다" }, { status: 400 });
    }

    const declaredExtensionValue = req.headers.get(UPLOAD_EXTENSION_HEADER);
    if (declaredExtensionValue === null) {
      return apiJson({ error: `${UPLOAD_EXTENSION_HEADER} 헤더에 업로드 파일 확장자가 필요합니다` }, { status: 400 });
    }
    const declaredExtension = normalizeUploadExtension(declaredExtensionValue);
    if (!declaredExtension) {
      return apiJson({ error: `${UPLOAD_EXTENSION_HEADER} 헤더가 올바르지 않습니다` }, { status: 400 });
    }
    if (!uploadCapabilities.supportedExtensions.includes(declaredExtension)) {
      return apiJson({ error: unsupportedServerUploadMessage(declaredExtension, uploadCapabilities) }, { status: 400 });
    }

    // Upload admission happens before formData(), so concurrent body buffering
    // is bounded. The global content lease is intentionally acquired only
    // after the body and file envelope are valid; a slow client must not block
    // unrelated content edits and builds while it is still uploading.
    let uploadHeartbeat: LeaseHeartbeat | null = null;
    let contentHeartbeat: LeaseHeartbeat | null = null;
    try {
      if (context.canStartLongTask?.() === false) return serverDrainingResponse();
      const uploadAdmission = await runtimeState.acquireLease(
        uploadLeaseResource,
        leaseTtlMs,
        uploadConcurrency,
        "업로드 요청 수신 중",
      );
      if (!uploadAdmission.acquired) return uploadBusyResponse(uploadAdmission);
      const ownedUploadHeartbeat = keepLeaseAlive(runtimeState, uploadAdmission.lease, leaseTtlMs);
      uploadHeartbeat = ownedUploadHeartbeat;
      if (context.canStartLongTask?.() === false) return serverDrainingResponse();

      let formData: FormData;
      try {
        formData = await req.formData();
      } catch {
        return apiJson({ error: "올바른 multipart/form-data 요청이 필요합니다" }, { status: 400 });
      }
      await ownedUploadHeartbeat.assertOwned();

      const file = formData.get("file");
      if (!(file instanceof File)) {
        return apiJson({ error: "파일이 필요합니다" }, { status: 400 });
      }

      if (file.size === 0) {
        return apiJson({ error: "빈 파일은 업로드할 수 없습니다" }, { status: 400 });
      }
      if (file.size > maxUploadSize) {
        return apiJson({ error: "파일 크기가 50MB를 초과합니다" }, { status: 413 });
      }

      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      if (ext !== declaredExtension) {
        return apiJson({ error: "업로드 파일 확장자가 요청 헤더와 일치하지 않습니다" }, { status: 400 });
      }
      if (!uploadCapabilities.supportedExtensions.includes(ext)) {
        return apiJson({ error: unsupportedServerUploadMessage(ext, uploadCapabilities) }, { status: 400 });
      }

      if (context.canStartLongTask?.() === false) return serverDrainingResponse();

      const contentAdmission = await acquireContentLease(
        runtimeState,
        store,
        contentLeaseResource,
        leaseTtlMs,
        "업로드 처리 시작 중",
      );
      if (!contentAdmission.acquired) return conflictResponse(contentAdmission);
      const contentLease = contentAdmission.lease;
      const ownedContentHeartbeat = contentAdmission.heartbeat;
      contentHeartbeat = ownedContentHeartbeat;
      if (context.canStartLongTask?.() === false) return serverDrainingResponse();
      const contentFence = contentAdmission.fence;
      await ownedUploadHeartbeat.assertOwned();
      await ownedContentHeartbeat.assertOwned();
      await ownedUploadHeartbeat.stop();
      uploadHeartbeat = null;

      await updateOwnedLeaseStatus(ownedContentHeartbeat, contentLease, "파일 저장 중...");
      let filePath: string | null = null;
      try {
        await ownedContentHeartbeat.assertOwned();
        filePath = reserveImmutableUploadPath(root, file.name);
        await writePrivateUploadFile(filePath, file);
        await ownedContentHeartbeat.assertOwned();
      } catch (error) {
        if (filePath) cleanupUnpublishedUpload(root, store, filePath);
        if (error instanceof LeaseOwnershipLostError) throw error;
        return apiJson({ error: "파일을 저장하지 못했습니다" }, { status: 500 });
      }
      if (!filePath) return apiJson({ error: "파일을 저장하지 못했습니다" }, { status: 500 });
      await updateOwnedLeaseStatus(ownedContentHeartbeat, contentLease, "파일 처리 시작...");

      let taskId: string;
      try {
        const trackedJob = await startTrackedContentJob({
          runtimeState,
          store,
          fence: contentFence,
          contentHeartbeat: ownedContentHeartbeat,
          taskKind: "file-ingest",
          taskHeartbeatTtlMs,
          operation: async ({ assertOwned, signal }) => {
            try {
              await assertOwned();
              const { ingestFile } = await import("../../services/ingest");
              const { publishIngestGenerationWithSite } = await import("../../build/renderer");
              const currentConfig = loadConfig(root);
              const currentPersona = getActivePersona(currentConfig);

              await ingestFile(root, store, filePath, file.name, currentConfig.llm, currentPersona, (status) => {
                void updateOwnedLeaseStatus(ownedContentHeartbeat, contentLease, status).catch(() => undefined);
              }, currentConfig.schema, {
                signal,
                publishGeneration: async (generation) => {
                  await updateOwnedLeaseStatus(ownedContentHeartbeat, contentLease, "빌드 중...");
                  await assertOwned();
                  const published = await publishIngestGenerationWithSite(
                    store,
                    generation.stagingStore,
                    generation.stagingSourceId,
                    generation.draft,
                    generation.contentHash,
                    currentConfig,
                    root,
                  {
                    beforePublish: assertOwned,
                    stagedFigureDirectory: generation.stagedFigureDirectory,
                    publishFiles: generation.publishFiles,
                    },
                  );
                  return published.source;
                },
              });
              await assertOwned();
            } finally {
              cleanupUnpublishedUpload(root, store, filePath);
            }
          },
          reportError(error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`\x1b[31m❌ 파일 처리 실패: ${message}\x1b[0m`);
          },
        });
        taskId = trackedJob.taskId;
        context.trackBackgroundTask?.(
          trackedJob.completion,
          () => trackedJob.interrupt("Server shutdown drain timed out before this task completed"),
        );
      } catch (error) {
        cleanupUnpublishedUpload(root, store, filePath);
        return detachedJobStartErrorResponse(error);
      }

      // The detached job now owns the content heartbeat cleanup boundary.
      contentHeartbeat = null;
      return apiJson({ ok: true, message: "파일 처리 시작", task_id: taskId }, { status: 202 });
    } finally {
      await uploadHeartbeat?.stop();
      await contentHeartbeat?.stop();
    }
  }

  if (url.pathname === "/api/add" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (error) {
      return inputErrorResponse(error) ?? apiJson({ error: "요청을 읽지 못했습니다" }, { status: 400 });
    }
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) {
      return apiJson({ error: "source가 필요합니다" }, { status: 400 });
    }
    if (source.length > 4096) {
      return apiJson({ error: "source는 4096자 이하여야 합니다" }, { status: 400 });
    }

    try {
      const { validateUrl } = await import("../../ingest/web");
      await validateUrl(source);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return apiJson({ error: message }, { status: 400 });
    }

    if (context.canStartLongTask?.() === false) return serverDrainingResponse();
    const contentAdmission = await acquireContentLease(
      runtimeState,
      store,
      contentLeaseResource,
      leaseTtlMs,
      "URL 처리 시작 중...",
    );
    if (!contentAdmission.acquired) return conflictResponse(contentAdmission);
    if (context.canStartLongTask?.() === false) {
      await contentAdmission.heartbeat.stop();
      return serverDrainingResponse();
    }
    const contentLease = contentAdmission.lease;
    const contentHeartbeat = contentAdmission.heartbeat;
    const contentFence = contentAdmission.fence;

    let taskId: string;
    try {
      const trackedJob = await startTrackedContentJob({
        runtimeState,
        store,
        fence: contentFence,
        contentHeartbeat,
        taskKind: "url-ingest",
        taskHeartbeatTtlMs,
        operation: async ({ assertOwned, signal }) => {
          await assertOwned();
          const { ingestUrl } = await import("../../services/ingest");
          const { publishIngestGenerationWithSite } = await import("../../build/renderer");
          const currentConfig = loadConfig(root);
          const currentPersona = getActivePersona(currentConfig);

          await ingestUrl(root, store, source, currentConfig.llm, currentPersona, (status) => {
            void updateOwnedLeaseStatus(contentHeartbeat, contentLease, status).catch(() => undefined);
          }, currentConfig.schema, {
            signal,
            publishGeneration: async (generation) => {
              await updateOwnedLeaseStatus(contentHeartbeat, contentLease, "빌드 중...");
              await assertOwned();
              const published = await publishIngestGenerationWithSite(
                store,
                generation.stagingStore,
                generation.stagingSourceId,
                generation.draft,
                generation.contentHash,
                currentConfig,
                root,
                {
                  beforePublish: assertOwned,
                  stagedFigureDirectory: generation.stagedFigureDirectory,
                  publishFiles: generation.publishFiles,
                },
              );
              return published.source;
            },
          });
          await assertOwned();
        },
        reportError(error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`\x1b[31m❌ URL 처리 실패: ${message}\x1b[0m`);
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

    return apiJson({ ok: true, message: "처리 시작", task_id: taskId }, { status: 202 });
  }

  return null;
}
