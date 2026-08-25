/**
 * Shared helpers for the CLI `--json` flag.
 *
 * When a command runs with `--json`, stdout must carry exactly ONE machine
 * readable JSON document — no Korean prose, no ANSI color, no progress lines.
 * These helpers serialize that document consistently and, for commands that emit
 * progress noise (e.g. `add`), keep stdout clean by routing all other stdout
 * writes to stderr for the duration of the run.
 */

/** Serialize `value` as a single JSON document and print it to stdout. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export interface StdoutJsonCapture {
  /** Restore the original stdout writer. */
  restore(): void;
  /** Write the final JSON document to the REAL stdout, bypassing the redirect. */
  writeJson(value: unknown): void;
}

/**
 * Redirect everything written to stdout (console.log/info/debug progress and any
 * direct `process.stdout.write` calls anywhere in the async call tree) to stderr,
 * so stdout only ever receives the single JSON document produced by `writeJson`.
 * `console.error`/`console.warn` and other stderr output are left untouched.
 *
 * Note: in Bun `console.log` writes to fd 1 directly and does NOT go through
 * `process.stdout.write`, so the console methods must be patched in addition to
 * `process.stdout.write` to fully clean stdout.
 *
 * Call `restore()` in a `finally` block once the command completes.
 */
export function captureStdoutForJson(): StdoutJsonCapture {
  const realWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsole = { log: console.log, info: console.info, debug: console.debug };

  // Route console progress to stderr via the untouched console.error.
  const routed = (...args: unknown[]) => { console.error(...args); };
  console.log = routed;
  console.info = routed;
  console.debug = routed;

  // Belt-and-suspenders for any direct process.stdout.write callers.
  process.stdout.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) =>
    (stderrWrite as (...args: unknown[]) => boolean)(chunk, encoding, callback)) as typeof process.stdout.write;

  return {
    restore() {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
      process.stdout.write = realWrite;
    },
    writeJson(value: unknown) {
      realWrite(`${JSON.stringify(value, null, 2)}\n`);
    },
  };
}
