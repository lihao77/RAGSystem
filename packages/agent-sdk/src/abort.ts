/** Error used when an agent runtime observes an aborted signal. */
export class RuntimeAbortError extends Error {
  constructor(message = "Runtime execution aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined, message?: string): void {
  if (signal?.aborted) {
    throw new RuntimeAbortError(message);
  }
}

/**
 * Wait for an operation without allowing a non-cooperative implementation to
 * hold an aborted run open forever. The operation is intentionally not
 * force-cancelled here; resource-owning callers still observe the same signal
 * and must clean up their resources themselves.
 */
export function abortable<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal | undefined,
  message = "Runtime execution aborted",
): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) {
    // The operation is created before this helper is called. Observe it even
    // when cancellation wins immediately, otherwise a rejecting tool promise
    // becomes an unhandled rejection.
    void Promise.resolve(operation).then(undefined, () => undefined);
    return Promise.reject(new RuntimeAbortError(message));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(new RuntimeAbortError(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof RuntimeAbortError
    || error instanceof Error && error.name === "AbortError";
}
