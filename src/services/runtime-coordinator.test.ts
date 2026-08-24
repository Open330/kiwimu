import { describe, expect, test } from "bun:test";
import { createRuntimeCoordinator } from "./runtime-coordinator";
import { RedisRuntimeState } from "./redis-runtime-state";

describe("runtime coordinator configuration", () => {
  test("requires an explicit project namespace for an external coordinator", async () => {
    await expect(createRuntimeCoordinator("/tmp/project", {
      KIWIMU_COORDINATOR_URL: "redis://127.0.0.1:6379",
    })).rejects.toThrow("KIWIMU_COORDINATOR_NAMESPACE is required");
  });

  test("rejects unsupported URL schemes and unsafe namespaces without exposing credentials", () => {
    expect(() => new RedisRuntimeState("https://user:secret@example.com", "project"))
      .toThrow("must use redis://");
    expect(() => new RedisRuntimeState("redis://user:secret@example.com", "bad{namespace}"))
      .toThrow("must contain 1-64");
  });
});
