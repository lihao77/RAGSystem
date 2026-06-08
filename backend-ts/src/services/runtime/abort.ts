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

export function isAbortError(error: unknown): boolean {
  return error instanceof RuntimeAbortError
    || error instanceof Error && error.name === "AbortError";
}
