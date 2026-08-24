const redisUrl = process.env.KIWIMU_TEST_REDIS_URL?.trim();

if (!redisUrl) {
  console.error("KIWIMU_TEST_REDIS_URL is required for the Redis integration test suite.");
  process.exit(1);
}

let parsed: URL;
try {
  parsed = new URL(redisUrl);
} catch {
  console.error("KIWIMU_TEST_REDIS_URL must be a valid Redis or Valkey URL.");
  process.exit(1);
}

if (!["redis:", "rediss:", "valkey:"].includes(parsed.protocol)) {
  console.error("KIWIMU_TEST_REDIS_URL must use redis://, rediss://, or valkey://.");
  process.exit(1);
}

const child = Bun.spawn(
  [process.execPath, "test", "--no-orphans", "src/services/redis-runtime-state.test.ts"],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env },
);
process.exitCode = await child.exited;
