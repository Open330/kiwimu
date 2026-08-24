import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaleContentFenceError } from "./content-fence-repository";
import { Store } from "../store";

const openStores: Store[] = [];
const tempRoots: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openSharedStores(): [Store, Store] {
  const root = mkdtempSync(join(tmpdir(), "kiwimu-content-fence-"));
  const dbPath = join(root, "wiki.db");
  const stores: [Store, Store] = [new Store(dbPath), new Store(dbPath)];
  tempRoots.push(root);
  openStores.push(...stores);
  return stores;
}

describe("content fencing", () => {
  test("activation is monotonic, same-acquisition idempotent, and scoped by resource", () => {
    const [store] = openSharedStores();
    const firstIdentity = {
      resource: "content",
      ownerToken: "worker-a",
      fencingToken: 41,
    };

    const first = store.activateContentFence(firstIdentity);
    expect(first).toEqual({ ...firstIdentity, epoch: 1 });
    expect(store.activateContentFence(firstIdentity)).toEqual(first);

    expect(() => store.activateContentFence({
      resource: "content",
      ownerToken: "worker-b",
      fencingToken: 41,
    })).toThrow(StaleContentFenceError);
    expect(() => store.activateContentFence({
      resource: "content",
      ownerToken: "worker-a",
      fencingToken: 40,
    })).toThrow(StaleContentFenceError);

    const second = store.activateContentFence({
      resource: "content",
      ownerToken: "worker-b",
      fencingToken: 99,
    });
    expect(second).toEqual({
      resource: "content",
      ownerToken: "worker-b",
      fencingToken: 99,
      epoch: 2,
    });
    expect(store.getActiveContentFence("content")).toEqual(second);

    expect(store.activateContentFence({
      resource: "search-index",
      ownerToken: "worker-c",
      fencingToken: 1,
    }).epoch).toBe(1);
  });

  test("a stale async owner cannot commit Store or repository mutations", async () => {
    const [staleStore, replacementStore] = openSharedStores();
    const source = staleStore.addSource("file:///fence.pdf", "pdf", "Fence", "raw");
    const page = staleStore.addPage("fenced-page", "Fenced page", "original", source.id);
    const firstFence = staleStore.activateContentFence({
      resource: "content",
      ownerToken: "worker-a",
      fencingToken: 1,
    });

    let signalEntered!: () => void;
    let releaseStaleJob!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const released = new Promise<void>((resolve) => { releaseStaleJob = resolve; });

    const staleJob = staleStore.runWithContentFence(firstFence, async () => {
      signalEntered();
      await released;

      const staleMutations = [
        () => staleStore.updatePageContent(page.id, "stale content"),
        () => staleStore.setCheckpoint(source.id, "stale-phase"),
        () => staleStore.replaceChunks(page.id, ["stale chunk"], "stale-hash"),
        () => staleStore.addFigure(source.id, "/static/stale.png", page.id),
        () => staleStore.quizRepository.addQuiz(page.id, "Stale?", "Yes", "short_answer"),
        () => staleStore.citationRepository.addCitation(page.id, source.id, page.id, "stale"),
        () => staleStore.activityRepository.addActivityLog("stale", "Stale activity"),
      ];
      for (const mutation of staleMutations) {
        expect(mutation).toThrow(StaleContentFenceError);
      }
    });

    await entered;
    const replacementFence = replacementStore.activateContentFence({
      resource: "content",
      ownerToken: "worker-b",
      fencingToken: 2,
    });
    releaseStaleJob();
    await staleJob;

    expect(replacementStore.getPage("fenced-page")?.content).toBe("original");
    expect(replacementStore.hasPhaseCheckpoint(source.id, "stale-phase")).toBeFalse();
    expect(replacementStore.countChunks()).toBe(0);
    expect(replacementStore.countFigures()).toBe(0);
    expect(replacementStore.getQuizzesByPage(page.id)).toEqual([]);
    expect(replacementStore.getCitationsForPage(page.id)).toEqual([]);
    expect(replacementStore.getActivityLog()).toEqual([]);

    replacementStore.runWithContentFence(replacementFence, () => {
      replacementStore.updatePageContent(page.id, "replacement content");
      replacementStore.activityRepository.addActivityLog("replacement", "Replacement activity");
    });
    expect(staleStore.getPage("fenced-page")?.content).toBe("replacement content");
    expect(staleStore.getActivityLog()).toHaveLength(1);
  });

  test("unfenced short-lived administrative writes remain compatible", () => {
    const [store] = openSharedStores();
    store.activateContentFence({
      resource: "content",
      ownerToken: "background-worker",
      fencingToken: 1,
    });

    const source = store.addSource("file:///admin.md", "md", "Admin", "raw");
    const page = store.addPage("admin-page", "Admin page", "body", source.id);
    store.updatePageContent(page.id, "manually edited");

    expect(store.getPage("admin-page")?.content).toBe("manually edited");
  });

  test("invalid external identities fail before changing the active epoch", () => {
    const [store] = openSharedStores();
    expect(() => store.activateContentFence({
      resource: "",
      ownerToken: "worker",
      fencingToken: 1,
    })).toThrow(TypeError);
    expect(() => store.activateContentFence({
      resource: "content",
      ownerToken: "",
      fencingToken: 1,
    })).toThrow(TypeError);
    expect(() => store.activateContentFence({
      resource: "content",
      ownerToken: "worker",
      fencingToken: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow(TypeError);
    expect(store.getActiveContentFence("content")).toBeNull();
  });
});
