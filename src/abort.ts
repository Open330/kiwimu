/** Return the caller-provided abort reason without losing its identity. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** Throw at cooperative checkpoints, including before expensive synchronous work. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Compose a caller cancellation signal with an absolute operation deadline.
 * The returned cleanup must be called so a completed request retains no timer
 * or listener references.
 */
export function withAbortDeadline(
  deadlineMs: number,
  deadlineError: Error,
  parent?: AbortSignal,
): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(abortReason(parent!));
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });

  const timer = setTimeout(() => controller.abort(deadlineError), deadlineMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

/** Await a promise while allowing cooperative cancellation of its caller. */
export async function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
