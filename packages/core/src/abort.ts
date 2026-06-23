/**
 * 运行时 abort 语义：取消信号工具（throwIfAborted / isAbortError / RuntimeAbortError）。
 *
 * 类型依赖：AbortSignal 由 devDependency @types/node 提供——core 的 tsconfig lib 仅
 * ES2022、不含 DOM，故 AbortSignal 全局类型只能来自 @types/node。
 * 切勿移除 core 的 @types/node，否则 AbortSignal 将无法解析。
 */
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
