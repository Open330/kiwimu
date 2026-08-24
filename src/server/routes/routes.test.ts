import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep as pathSeparator } from "node:path";
import { stringify } from "smol-toml";
import { CONFIG_FILE, defaultConfig } from "../../config";
import { UPLOAD_EXTENSION_HEADER } from "../../ingest/capabilities";
import { StaleContentFenceError } from "../../repositories/content-fence-repository";
import { Store } from "../../store";
import { handleAdminRoutes, type AdminRouteContext } from "./admin";
import {
  handleContentRoutes,
  type ContentRequestServer,
  type ContentRouteContext,
} from "./content";
import {
  cleanupUnpublishedUpload,
  handleIngestRoutes,
  reserveImmutableUploadPath,
  writePrivateUploadFile,
  type IngestRouteContext,
} from "./ingest";
import { handleReadRoutes, type ReadRouteContext, type RequestIpServer } from "./read";

const temporaryDirectories: string[] = [];

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kiwimu-routes-"));
  temporaryDirectories.push(root);
  const config = defaultConfig("Route test wiki");
  config.llm.api_key = "secret-api-key";
  writeFileSync(join(root, CONFIG_FILE), stringify(config));
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ingest route ownership", () => {
  test("reserves unique immutable paths while retaining the original basename", () => {
    const root = makeProjectRoot();
    const first = reserveImmutableUploadPath(root, "../study notes.md");
    const second = reserveImmutableUploadPath(root, "../study notes.md");

    expect(first).not.toBe(second);
    expect(first.endsWith(`${pathSeparator}study notes.md`)).toBeTrue();
    expect(second.endsWith(`${pathSeparator}study notes.md`)).toBeTrue();
    expect(existsSync(dirname(first))).toBeTrue();
    expect(existsSync(dirname(second))).toBeTrue();
  });

  test.skipIf(process.platform === "win32")("uses private POSIX modes for upload directories and files", async () => {
    const root = makeProjectRoot();
    const uploadRoot = join(root, "uploads");
    mkdirSync(uploadRoot, { mode: 0o755 });
    chmodSync(uploadRoot, 0o755);

    const filePath = reserveImmutableUploadPath(root, "private.md");
    await writePrivateUploadFile(filePath, new Blob(["private upload"]));

    expect(statSync(uploadRoot).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("rejects unsafe upload roots without touching external targets", () => {
    const root = makeProjectRoot();
    const external = makeProjectRoot();
    const marker = join(external, "keep.txt");
    writeFileSync(marker, "keep", { mode: 0o644 });
    chmodSync(external, 0o755);
    symlinkSync(external, join(root, "uploads"), "dir");

    expect(() => reserveImmutableUploadPath(root, "upload.md")).toThrow("Unsafe upload root");
    expect(readFileSync(marker, "utf8")).toBe("keep");
    expect(statSync(external).mode & 0o777).toBe(0o755);
    expect(readdirSync(external).sort()).toEqual(["keep.txt", "kiwi.toml"]);

    rmSync(join(root, "uploads"));
    writeFileSync(join(root, "uploads"), "not a directory", { mode: 0o644 });
    expect(() => reserveImmutableUploadPath(root, "upload.md")).toThrow("Unsafe upload root");
    expect(readFileSync(join(root, "uploads"), "utf8")).toBe("not a directory");
  });

  test("cleans a reserved upload only when no live Source references it", async () => {
    const root = makeProjectRoot();
    const abandoned = reserveImmutableUploadPath(root, "abandoned.md");
    await writePrivateUploadFile(abandoned, new Blob(["abandoned"]));
    expect(cleanupUnpublishedUpload(root, { getSource: () => null }, abandoned)).toBeTrue();
    expect(existsSync(abandoned)).toBeFalse();

    const published = reserveImmutableUploadPath(root, "published.md");
    await writePrivateUploadFile(published, new Blob(["published"]));
    expect(cleanupUnpublishedUpload(root, {
      getSource: () => ({ id: 1 } as any),
    }, published)).toBeFalse();
    expect(existsSync(published)).toBeTrue();
  });

  test("does not claim unmatched methods", async () => {
    const request = new Request("http://localhost/api/upload");
    const result = await handleIngestRoutes(
      request,
      new URL(request.url),
      {} as IngestRouteContext,
    );

    expect(result).toBeNull();
  });

  test("rejects an invalid upload envelope before acquiring admission", async () => {
    let admissionAttempted = false;
    const context = {
      runtimeState: {
        acquireLease() {
          admissionAttempted = true;
          throw new Error("must not acquire admission");
        },
      },
      maxUploadBodySize: 1024,
    } as unknown as IngestRouteContext;
    const request = new Request("http://localhost/api/upload", { method: "POST" });
    const response = await handleIngestRoutes(request, new URL(request.url), context);

    expect(response?.status).toBe(400);
    expect(admissionAttempted).toBeFalse();
  });

  test("does not acquire the content lease until the multipart body is received and valid", async () => {
    const admissions: string[] = [];
    let releaseFormData!: (value: FormData) => void;
    const pendingFormData = new Promise<FormData>((resolve) => { releaseFormData = resolve; });
    const uploadLease = {
      resource: "upload-admission",
      slot: 0,
      ownerToken: "upload-owner",
      fencingToken: 1,
    };
    const context = {
      contentLeaseResource: "content-mutation",
      uploadLeaseResource: "upload-admission",
      leaseTtlMs: 30_000,
      taskHeartbeatTtlMs: 30_000,
      uploadConcurrency: 1,
      maxUploadSize: 1024,
      maxUploadBodySize: 2048,
      runtimeState: {
        async acquireLease(resource: string) {
          admissions.push(resource);
          if (resource === "upload-admission") {
            return { acquired: true, retryAfterSeconds: 0, lease: uploadLease };
          }
          return { acquired: false, retryAfterSeconds: 3, status: "busy" };
        },
        async isLeaseOwned() { return true; },
        async renewLease() { return true; },
        async releaseLease() { return true; },
      },
    } as unknown as IngestRouteContext;
    const request = {
      method: "POST",
      headers: new Headers({
        "Content-Type": "multipart/form-data; boundary=kiwi",
        [UPLOAD_EXTENSION_HEADER]: "md",
      }),
      formData: () => pendingFormData,
    } as unknown as Request;

    const responsePromise = handleIngestRoutes(
      request,
      new URL("http://localhost/api/upload"),
      context,
    );
    await Bun.sleep(0);
    expect(admissions).toEqual(["upload-admission"]);

    const formData = new FormData();
    formData.set("file", new File(["# valid markdown"], "note.md", { type: "text/markdown" }));
    releaseFormData(formData);
    const response = await responsePromise;

    expect(response?.status).toBe(409);
    expect(admissions).toEqual(["upload-admission", "content-mutation"]);
  });

  test("rejects an unsupported file before acquiring the content lease", async () => {
    const admissions: string[] = [];
    const context = {
      contentLeaseResource: "content-mutation",
      uploadLeaseResource: "upload-admission",
      leaseTtlMs: 30_000,
      taskHeartbeatTtlMs: 30_000,
      uploadConcurrency: 1,
      maxUploadSize: 1024,
      maxUploadBodySize: 2048,
      runtimeState: {
        async acquireLease(resource: string) {
          admissions.push(resource);
          return {
            acquired: true,
            retryAfterSeconds: 0,
            lease: { resource, slot: 0, ownerToken: "owner", fencingToken: 1 },
          };
        },
        async isLeaseOwned() { return true; },
        async renewLease() { return true; },
        async releaseLease() { return true; },
      },
    } as unknown as IngestRouteContext;
    const formData = new FormData();
    formData.set("file", new File(["unsupported"], "note.exe"));
    const request = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { [UPLOAD_EXTENSION_HEADER]: "exe" },
      body: formData,
    });

    const response = await handleIngestRoutes(request, new URL(request.url), context);

    expect(response?.status).toBe(400);
    expect(admissions).toEqual([]);
  });

  test("rejects an unavailable legacy extractor before reading the body or acquiring a lease", async () => {
    let bodyRead = false;
    let admissionAttempted = false;
    const context = {
      maxUploadBodySize: 2048,
      uploadCapabilities: {
        supportedExtensions: ["pdf", "docx", "pptx", "md"],
        missingCommandByExtension: { doc: "textutil" },
      },
      runtimeState: {
        acquireLease() {
          admissionAttempted = true;
          throw new Error("must not acquire admission");
        },
      },
    } as unknown as IngestRouteContext;
    const request = {
      method: "POST",
      headers: new Headers({
        "Content-Type": "multipart/form-data; boundary=kiwi",
        [UPLOAD_EXTENSION_HEADER]: "doc",
      }),
      formData() {
        bodyRead = true;
        throw new Error("must not read multipart body");
      },
    } as unknown as Request;

    const response = await handleIngestRoutes(request, new URL("http://localhost/api/upload"), context);

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: expect.stringContaining("textutil 추출 명령이 필요합니다") });
    expect(bodyRead).toBeFalse();
    expect(admissionAttempted).toBeFalse();
  });

  test("releases upload admission when content admission throws", async () => {
    const releases = new Map<string, number>();
    let admissions = 0;
    const uploadLease = {
      resource: "upload-admission",
      slot: 0,
      ownerToken: "upload-owner",
      fencingToken: 1,
    };
    const context = {
      root: makeProjectRoot(),
      contentLeaseResource: "content-mutation",
      uploadLeaseResource: "upload-admission",
      leaseTtlMs: 30_000,
      uploadConcurrency: 1,
      maxUploadSize: 1024,
      maxUploadBodySize: 2048,
      runtimeState: {
        async acquireLease() {
          admissions += 1;
          if (admissions === 1) {
            return { acquired: true, retryAfterSeconds: 0, lease: uploadLease };
          }
          throw new Error("coordinator unavailable");
        },
        async isLeaseOwned() { return true; },
        async renewLease() { return true; },
        async createTask() {},
        async heartbeatTask() { return true; },
        async completeTask() { return true; },
        async failTask() { return true; },
        async releaseLease(lease: { resource: string }) {
          releases.set(lease.resource, (releases.get(lease.resource) ?? 0) + 1);
          return true;
        },
      },
    } as unknown as IngestRouteContext;
    const formData = new FormData();
    formData.set("file", new File(["# valid markdown"], "note.md", { type: "text/markdown" }));
    const request = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { [UPLOAD_EXTENSION_HEADER]: "md" },
      body: formData,
    });

    await expect(handleIngestRoutes(request, new URL(request.url), context)).rejects.toThrow("coordinator unavailable");
    expect(releases.get("upload-admission")).toBe(1);
  });

  test("releases content admission when upload status update throws", async () => {
    const releases = new Map<string, number>();
    let fencingToken = 0;
    const context = {
      root: makeProjectRoot(),
      contentLeaseResource: "content-mutation",
      uploadLeaseResource: "upload-admission",
      leaseTtlMs: 30_000,
      uploadConcurrency: 1,
      maxUploadSize: 1024,
      maxUploadBodySize: 2048,
      runtimeState: {
        async acquireLease(resource: string) {
          fencingToken += 1;
          return {
            acquired: true,
            retryAfterSeconds: 0,
            lease: { resource, slot: 0, ownerToken: `owner-${fencingToken}`, fencingToken },
          };
        },
        async isLeaseOwned() { return true; },
        async renewLease() { return true; },
        async createTask() {},
        async heartbeatTask() { return true; },
        async completeTask() { return true; },
        async failTask() { return true; },
        async releaseLease(lease: { resource: string }) {
          releases.set(lease.resource, (releases.get(lease.resource) ?? 0) + 1);
          return true;
        },
      },
      store: {
        activateContentFence(lease: { resource: string; ownerToken: string; fencingToken: number }) {
          return { ...lease, epoch: 1 };
        },
        getActiveContentFence() { return null; },
      },
      async updateOwnedLeaseStatus() {
        throw new Error("status update failed");
      },
    } as unknown as IngestRouteContext;
    const formData = new FormData();
    formData.set("file", new File(["# valid markdown"], "note.md", { type: "text/markdown" }));
    const request = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { [UPLOAD_EXTENSION_HEADER]: "md" },
      body: formData,
    });

    await expect(handleIngestRoutes(request, new URL(request.url), context)).rejects.toThrow("status update failed");
    expect(releases.get("upload-admission")).toBe(1);
    expect(releases.get("content-mutation")).toBe(1);
  });

  test("returns a controlled error and releases both leases when detached ingest cannot start", async () => {
    const root = makeProjectRoot();
    const releases = new Map<string, number>();
    let fencingToken = 0;
    const context = {
      root,
      contentLeaseResource: "content-mutation",
      uploadLeaseResource: "upload-admission",
      leaseTtlMs: 30_000,
      taskHeartbeatTtlMs: 30_000,
      uploadConcurrency: 1,
      maxUploadSize: 1024,
      maxUploadBodySize: 2048,
      runtimeState: {
        async acquireLease(resource: string) {
          fencingToken += 1;
          return {
            acquired: true,
            retryAfterSeconds: 0,
            lease: { resource, slot: 0, ownerToken: `owner-${fencingToken}`, fencingToken },
          };
        },
        async isLeaseOwned() { return true; },
        async renewLease() { return true; },
        async createTask() {},
        async heartbeatTask() { return true; },
        async completeTask() { return true; },
        async failTask() { return true; },
        async releaseLease(lease: { resource: string }) {
          releases.set(lease.resource, (releases.get(lease.resource) ?? 0) + 1);
          return true;
        },
      },
      store: {
        activateContentFence(lease: { resource: string; ownerToken: string; fencingToken: number }) {
          return { ...lease, epoch: 1 };
        },
        getActiveContentFence() { return null; },
        runWithContentFence() { throw new StaleContentFenceError("content-mutation"); },
      },
      async updateOwnedLeaseStatus() {},
    } as unknown as IngestRouteContext;
    const formData = new FormData();
    formData.set("file", new File(["# valid markdown"], "note.md", { type: "text/markdown" }));
    const request = new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { [UPLOAD_EXTENSION_HEADER]: "md" },
      body: formData,
    });
    const response = await handleIngestRoutes(request, new URL(request.url), context);

    expect(response?.status).toBe(503);
    expect(releases.get("upload-admission")).toBe(1);
    expect(releases.get("content-mutation")).toBe(1);
  });
});

describe("admin route ownership", () => {
  test("masks the configured API key", async () => {
    const root = makeProjectRoot();
    const request = new Request("http://localhost/api/settings");
    const response = await handleAdminRoutes(
      request,
      new URL(request.url),
      { root } as AdminRouteContext,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ api_key: "••••-key" });
  });

  test("leaves unsupported settings methods to the API fallback", async () => {
    const request = new Request("http://localhost/api/settings", { method: "DELETE" });
    const result = await handleAdminRoutes(
      request,
      new URL(request.url),
      {} as AdminRouteContext,
    );

    expect(result).toBeNull();
  });

  test("rejects unsupported providers and unsafe Azure endpoints before lease admission", async () => {
    const root = makeProjectRoot();
    let admissionAttempted = false;
    const context = {
      root,
      runtimeState: {
        acquireLease() {
          admissionAttempted = true;
          throw new Error("must not acquire admission");
        },
      },
    } as unknown as AdminRouteContext;
    const invalidBodies = [
      { provider: "custom-provider" },
      { provider: "azure-openai", endpoint: "" },
      { provider: " azure-openai ", endpoint: "" },
      { provider: "azure-openai", endpoint: "http://resource.openai.azure.com" },
      { provider: "azure-openai", endpoint: "https://user:pass@resource.openai.azure.com" },
      { provider: "azure-openai", endpoint: "https://127.0.0.1" },
      { provider: "azure-openai", endpoint: "https://resource.openai.azure.com:8443" },
    ];

    for (const body of invalidBodies) {
      const request = new Request("http://localhost/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const response = await handleAdminRoutes(request, new URL(request.url), context);
      expect(response?.status).toBe(400);
    }
    expect(admissionAttempted).toBeFalse();
  });

  test("accepts an official Azure OpenAI endpoint before normal lease admission", async () => {
    const root = makeProjectRoot();
    let admissionAttempted = false;
    const context = {
      root,
      contentLeaseResource: "content-mutation",
      leaseTtlMs: 30_000,
      taskHeartbeatTtlMs: 30_000,
      runtimeState: {
        async acquireLease() {
          admissionAttempted = true;
          return { acquired: false, retryAfterSeconds: 2, status: "busy" };
        },
      },
    } as unknown as AdminRouteContext;
    const request = new Request("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "azure-openai",
        endpoint: "https://kiwimu-resource.openai.azure.com/",
      }),
    });

    const response = await handleAdminRoutes(request, new URL(request.url), context);

    expect(response?.status).toBe(409);
    expect(admissionAttempted).toBeTrue();
  });

  test("returns a controlled error and releases the lease when detached build cannot start", async () => {
    const lease = {
      resource: "content-mutation",
      slot: 0,
      ownerToken: "owner-1",
      fencingToken: 1,
    };
    let releases = 0;
    const context = {
      root: makeProjectRoot(),
      contentLeaseResource: "content-mutation",
      leaseTtlMs: 30_000,
      taskHeartbeatTtlMs: 30_000,
      runtimeState: {
        async acquireLease() { return { acquired: true, retryAfterSeconds: 0, lease }; },
        async isLeaseOwned() { return true; },
        async renewLease() { return true; },
        async createTask() {},
        async heartbeatTask() { return true; },
        async completeTask() { return true; },
        async failTask() { return true; },
        async releaseLease() { releases += 1; return true; },
      },
      store: {
        activateContentFence() { return { ...lease, epoch: 1 }; },
        getActiveContentFence() { return null; },
        runWithContentFence() { throw new StaleContentFenceError("content-mutation"); },
      },
    } as unknown as AdminRouteContext;
    const request = new Request("http://localhost/api/build", { method: "POST" });
    const response = await handleAdminRoutes(request, new URL(request.url), context);

    expect(response?.status).toBe(503);
    expect(releases).toBe(1);
  });
});

describe("content mutation route ownership", () => {
  const server: ContentRequestServer = { requestIP: () => ({ address: "127.0.0.1" }) };

  function contentEditContext(
    root: string,
    store: Store,
    isLeaseOwned: () => boolean = () => true,
  ): ContentRouteContext {
    const lease = {
      resource: "content-mutation",
      slot: 0,
      ownerToken: "page-editor",
      fencingToken: 1,
    };
    return {
      root,
      store,
      contentLeaseResource: lease.resource,
      leaseTtlMs: 30_000,
      taskHeartbeatTtlMs: 30_000,
      askRateLimit: 10,
      askRateWindow: 60_000,
      rateLimitKey: () => "local",
      runtimeState: {
        async acquireLease() { return { acquired: true, retryAfterSeconds: 0, lease }; },
        async isLeaseOwned() { return isLeaseOwned(); },
        async renewLease() { return true; },
        async releaseLease() { return true; },
        async ensureLeaseFencingToken() {},
      },
    } as unknown as ContentRouteContext;
  }

  function addCitedPage(store: Store): { slug: string; content: string; pageId: number } {
    const source = store.addSource("file:///source.md", "md", "Source", "raw");
    const sourcePage = store.addPage("source-page", "Source page", "Source body", source.id, undefined, "source");
    const content = 'Claim <sup class="citation-ref"><a href="#cite-1" title="Source page">[1]</a></sup>.';
    const page = store.addPage("edited-page", "Edited page", content);
    store.addCitation(page.id, source.id, sourcePage.id, "Claim", "context");
    return { slug: page.slug, content, pageId: page.id };
  }

  test("owns dynamic task status and returns the coordinator result", async () => {
    const context = {
      runtimeState: {
        async getTask(taskId: string) {
          return { id: taskId, kind: "dynamic-qa", status: "processing" };
        },
      },
    } as unknown as ContentRouteContext;
    const request = new Request("http://localhost/api/ask/status?task_id=task-1");
    const response = await handleContentRoutes(request, new URL(request.url), server, context);

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ id: "task-1", status: "processing" });
  });

  test("a no-op page save preserves citations", async () => {
    const root = makeProjectRoot();
    const store = new Store(join(root, "kiwi.db"));
    try {
      const page = addCitedPage(store);
      const request = new Request("http://localhost/api/page/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: page.slug, content: page.content }),
      });

      const response = await handleContentRoutes(
        request,
        new URL(request.url),
        server,
        contentEditContext(root, store),
      );

      expect(response?.status).toBe(200);
      expect(store.getPage(page.slug)).toMatchObject({
        content: page.content,
        manual_revision: 0,
      });
      expect(store.getCitationsForPage(page.pageId)).toHaveLength(1);
      const html = readFileSync(join(root, "_site", "wiki", `${page.slug}.html`), "utf8");
      expect(html).toContain('class="citation-ref"');
      expect(html).toContain('class="citations-section"');
    } finally {
      store.close();
    }
  });

  test("a changed page save clears citations and generated citation references together", async () => {
    const root = makeProjectRoot();
    const store = new Store(join(root, "kiwi.db"));
    try {
      const page = addCitedPage(store);
      const request = new Request("http://localhost/api/page/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: page.slug, content: `${page.content}\n\nChanged paragraph.` }),
      });

      const response = await handleContentRoutes(
        request,
        new URL(request.url),
        server,
        contentEditContext(root, store),
      );

      expect(response?.status).toBe(200);
      expect(store.getPage(page.slug)).toMatchObject({
        content: "Claim.\n\nChanged paragraph.",
        manual_revision: 1,
      });
      expect(store.getCitationsForPage(page.pageId)).toEqual([]);
      const html = readFileSync(join(root, "_site", "wiki", `${page.slug}.html`), "utf8");
      expect(html).toContain("Changed paragraph.");
      expect(html).not.toContain('class="citation-ref"');
      expect(html).not.toContain('class="citations-section"');
    } finally {
      store.close();
    }
  });

  test("lease loss before final page publication preserves DB, citations, and static files", async () => {
    const root = makeProjectRoot();
    const store = new Store(join(root, "kiwi.db"));
    try {
      const page = addCitedPage(store);
      mkdirSync(join(root, "_site", "wiki"), { recursive: true });
      writeFileSync(join(root, "_site", "wiki", `${page.slug}.html`), "STATIC-BEFORE");
      writeFileSync(join(root, "_site", "search-index.json"), JSON.stringify([
        { slug: page.slug, title: "Before", preview: "before", type: "concept" },
      ]));
      let ownershipChecks = 0;
      const request = new Request("http://localhost/api/page/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: page.slug, content: `${page.content}\nchanged` }),
      });

      const response = await handleContentRoutes(
        request,
        new URL(request.url),
        server,
        contentEditContext(root, store, () => ++ownershipChecks === 1),
      );

      expect(response?.status).toBe(503);
      expect(store.getPage(page.slug)?.content).toBe(page.content);
      expect(store.getCitationsForPage(page.pageId)).toHaveLength(1);
      expect(readFileSync(join(root, "_site", "wiki", `${page.slug}.html`), "utf8")).toBe("STATIC-BEFORE");
      expect(JSON.parse(readFileSync(join(root, "_site", "search-index.json"), "utf8"))[0].title).toBe("Before");
    } finally {
      store.close();
    }
  });

  test("keeps stale content-fence failures as retryable 503 responses", async () => {
    const lease = {
      resource: "content-mutation",
      slot: 0,
      ownerToken: "owner-1",
      fencingToken: 1,
    };
    let released = false;
    const context = {
      root: makeProjectRoot(),
      contentLeaseResource: "content-mutation",
      leaseTtlMs: 30_000,
      store: {
        getPage() {
          return { slug: "page", content: "before" };
        },
        activateContentFence() {
          throw new StaleContentFenceError("content-mutation");
        },
        getActiveContentFence() {
          return { ...lease, epoch: 1 };
        },
      },
      runtimeState: {
        async acquireLease() {
          return { acquired: true, lease };
        },
        async releaseLease() {
          released = true;
          return true;
        },
        async ensureLeaseFencingToken() {},
      },
    } as unknown as ContentRouteContext;
    const request = new Request("http://localhost/api/page/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "page", content: "after" }),
    });
    const response = await handleContentRoutes(request, new URL(request.url), server, context);

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: "콘텐츠 쓰기 소유권을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
    });
    expect(released).toBeTrue();
  });

  test("leaves unsupported methods and unrelated routes to the API fallback", async () => {
    const requests = [
      new Request("http://localhost/api/ask"),
      new Request("http://localhost/api/ask/status", { method: "POST" }),
      new Request("http://localhost/api/promote"),
      new Request("http://localhost/api/page/edit"),
      new Request("http://localhost/api/search"),
    ];

    for (const request of requests) {
      expect(
        await handleContentRoutes(request, new URL(request.url), server, {} as ContentRouteContext),
      ).toBeNull();
    }
  });
});

describe("read route ownership", () => {
  const server: RequestIpServer = { requestIP: () => ({ address: "127.0.0.1" }) };

  test("returns tracked task processing, completed, error, and missing states", async () => {
    const taskId = "123e4567-e89b-42d3-a456-426614174000";
    const states = [
      { status: "processing" },
      { status: "completed", result: { ok: true } },
      { status: "error", error: "build failed" },
    ];
    for (const state of states) {
      const context = {
        runtimeState: { async getTask() { return state; } },
      } as unknown as ReadRouteContext;
      const request = new Request(`http://localhost/api/tasks/${taskId}`);
      const response = await handleReadRoutes(request, new URL(request.url), server, context);

      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual(state);
    }

    const missingContext = {
      runtimeState: { async getTask() { return null; } },
    } as unknown as ReadRouteContext;
    const missing = new Request(`http://localhost/api/tasks/${taskId}`);
    const missingResponse = await handleReadRoutes(missing, new URL(missing.url), server, missingContext);
    expect(missingResponse?.status).toBe(404);
    expect(await missingResponse?.json()).toEqual({ error: "작업을 찾을 수 없습니다" });
  });

  test("clamps activity pagination before querying the store", async () => {
    let query: [number, number, string | undefined] | undefined;
    const context = {
      store: {
        getActivityLog(limit: number, offset: number, action?: string) {
          query = [limit, offset, action];
          return [{ id: 1 }];
        },
        getActivityStats() {
          return { total: 7 };
        },
      },
    } as unknown as ReadRouteContext;
    const request = new Request("http://localhost/api/activity?limit=999&offset=-4&action=build");
    const response = await handleReadRoutes(request, new URL(request.url), server, context);

    expect(query).toEqual([200, 0, "build"]);
    expect(await response?.json()).toEqual({ entries: [{ id: 1 }], total: 7 });
  });

  test("rejects an unsafe activity offset before querying SQLite", async () => {
    let queried = false;
    const context = {
      store: {
        getActivityLog() {
          queried = true;
          throw new Error("must not query storage");
        },
      },
    } as unknown as ReadRouteContext;
    const request = new Request(
      "http://localhost/api/activity?offset=9999999999999999999999999999999",
    );
    const response = await handleReadRoutes(request, new URL(request.url), server, context);

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "offset은 안전한 정수여야 합니다" });
    expect(queried).toBeFalse();
  });

  test("rejects malformed page slugs without querying storage", async () => {
    const request = new Request("http://localhost/api/page/%");
    const response = await handleReadRoutes(
      request,
      new URL(request.url),
      server,
      {} as ReadRouteContext,
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "잘못 인코딩된 slug입니다" });
  });

  test("does not claim page edit or unsupported read methods", async () => {
    const pageEdit = new Request("http://localhost/api/page/edit", { method: "POST" });
    const searchPost = new Request("http://localhost/api/search", { method: "POST" });
    const taskPost = new Request("http://localhost/api/tasks/123e4567-e89b-42d3-a456-426614174000", { method: "POST" });

    expect(await handleReadRoutes(pageEdit, new URL(pageEdit.url), server, {} as ReadRouteContext)).toBeNull();
    expect(await handleReadRoutes(searchPost, new URL(searchPost.url), server, {} as ReadRouteContext)).toBeNull();
    expect(await handleReadRoutes(taskPost, new URL(taskPost.url), server, {} as ReadRouteContext)).toBeNull();
  });
});
