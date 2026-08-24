import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaleContentFenceError } from "../repositories/content-fence-repository";
import { RuntimeState, RUNTIME_DB_FILE } from "../services/runtime-state";
import { Store } from "../store";
import {
  CliContentConflictError,
  CONTENT_LEASE_RESOURCE,
  runCliContentJob,
} from "./content-job";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kiwimu-cli-fence-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI content job fencing", () => {
  test("fails closed without invoking a command when another owner holds the lease", async () => {
    const root = makeRoot();
    const store = new Store(join(root, "kiwi.db"));
    const owner = new RuntimeState(join(root, RUNTIME_DB_FILE), "owner");
    const admission = owner.acquireLease(CONTENT_LEASE_RESOURCE, 30_000, 1, "server ingest");
    expect(admission.acquired).toBeTrue();
    let invoked = false;

    try {
      await expect(runCliContentJob(
        root,
        store,
        "CLI ingest",
        () => { invoked = true; },
        { createCoordinator: () => new RuntimeState(join(root, RUNTIME_DB_FILE), "cli") },
      )).rejects.toBeInstanceOf(CliContentConflictError);
      expect(invoked).toBeFalse();
    } finally {
      if (admission.acquired) owner.releaseLease(admission.lease);
      owner.close();
      store.close();
    }
  });

  test("rejects a delayed CLI write after a replacement generation activates", async () => {
    const root = makeRoot();
    const staleStore = new Store(join(root, "kiwi.db"));
    const replacementStore = new Store(join(root, "kiwi.db"));
    const replacementRuntime = new RuntimeState(join(root, RUNTIME_DB_FILE), "replacement");
    const source = staleStore.addSource("file:///before.md", "md", "Before", "raw");
    const page = staleStore.addPage("shared", "Shared", "before", source.id);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let resume!: () => void;
    const resumePromise = new Promise<void>((resolve) => { resume = resolve; });

    const staleJob = runCliContentJob(
      root,
      staleStore,
      "delayed CLI mutation",
      async () => {
        started();
        await resumePromise;
        staleStore.updatePageContent(page.id, "stale overwrite");
      },
      {
        leaseTtlMs: 20,
        createCoordinator: () => new RuntimeState(join(root, RUNTIME_DB_FILE), "stale-cli"),
      },
    );

    try {
      await startedPromise;
      await Bun.sleep(30);
      const replacement = replacementRuntime.acquireLease(
        CONTENT_LEASE_RESOURCE,
        30_000,
        1,
        "replacement",
      );
      expect(replacement.acquired).toBeTrue();
      if (!replacement.acquired) throw new Error("replacement lease was not acquired");
      const replacementFence = replacementStore.activateContentFence(replacement.lease);
      replacementStore.runWithContentFence(replacementFence, () => {
        replacementStore.updatePageContent(page.id, "replacement content");
      });

      resume();
      await expect(staleJob).rejects.toBeInstanceOf(StaleContentFenceError);
      expect(replacementStore.getPage("shared")?.content).toBe("replacement content");
      replacementRuntime.releaseLease(replacement.lease);
    } finally {
      resume();
      await staleJob.catch(() => undefined);
      replacementRuntime.close();
      replacementStore.close();
      staleStore.close();
    }
  });
});
