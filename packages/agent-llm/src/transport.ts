/**
 * Provider 调用策略层执行核：线协议（URL/鉴权/SSE 解析）已下沉官方 SDK，
 * 本层保留 agent-llm 自持的传输语义——重试调度、熔断、尝试生命周期事件、
 * 总/空闲看门狗、ipc_socket 本地组网注入。结构与 pi-ai 的 retryProviderRequest +
 * 三层 abort 判定同型：入口预检、signal 进 SDK、流后判定。
 */
import { randomUUID } from "node:crypto";
import { request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { APIConnectionError as OpenAiConnectionError, APIConnectionTimeoutError as OpenAiConnectionTimeoutError } from "openai";
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
} from "@anthropic-ai/sdk";
import type { LlmRequest, LlmStreamHandler, ProviderConfig } from "./types.js";
import { DEFAULT_ENDPOINTS } from "./provider-registry.js";
import {
  DEFAULT_PROVIDER_TIMEOUT_SECONDS,
  externalCallPolicy,
  ExternalCallTimeoutError,
  isRetryableHttpStatus,
  providerCallPolicy,
  RetryableHttpError,
} from "./external-call-policy.js";
import { isRecord } from "./internal/records.js";
import { isWireCaptureEnabled, wrapFetchWithWireCapture } from "./wire-capture.js";

export function requireApiKey(provider: ProviderConfig): string {
  const apiKey = String(provider.api_key ?? "").trim();
  if (!apiKey) throw new Error("Provider API key is required");
  return apiKey;
}

export function extractErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return typeof body.message === "string" ? body.message : null;
}

/**
 * 策略包装：物理重试 + 熔断 + 尝试生命周期事件。operation 返回最终 LlmResult，
 * 重试判定基于归一后的错误（normalizeProviderError）。operationTimeoutMs 保持 null——
 * 分相超时（连接/读流）由 AttemptGuard 在 operation 内自管。
 */
export async function executeProviderOperation<T>(
  request: LlmRequest,
  operation: (context: { attempt: number; signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const key = circuitKey(request);
  const policy = providerCallPolicy(request.provider);
  const attemptIds = new Map<number, { id: string; startedAt: number }>();
  return externalCallPolicy.execute({
    key,
    ...policy,
    operationTimeoutMs: null,
    ...(request.signal ? { signal: request.signal } : {}),
    onAttemptStarted: ({ attempt, maxAttempts }) => {
      const attemptId = randomUUID();
      attemptIds.set(attempt, { id: attemptId, startedAt: Date.now() });
      request.onAttemptLifecycle?.({ phase: "started", attemptId, attempt, maxAttempts });
    },
    onAttemptFailed: ({ attempt, maxAttempts, error, willRetry, delayMs }) => {
      const current = attemptIds.get(attempt) ?? { id: randomUUID(), startedAt: Date.now() };
      request.onAttemptLifecycle?.({
        phase: "failed",
        attemptId: current.id,
        attempt,
        maxAttempts,
        willRetry,
        ...(delayMs !== undefined ? { retryDelayMs: delayMs } : {}),
        elapsedMs: Math.max(0, Date.now() - current.startedAt),
        error: errorMessage(error),
      });
    },
    onAttemptCompleted: ({ attempt, maxAttempts }) => {
      const current = attemptIds.get(attempt) ?? { id: randomUUID(), startedAt: Date.now() };
      request.onAttemptLifecycle?.({
        phase: "completed",
        attemptId: current.id,
        attempt,
        maxAttempts,
        elapsedMs: Math.max(0, Date.now() - current.startedAt),
      });
    },
    operation,
  });
}

/**
 * 单次尝试守卫：串接调用方 signal，自持超时中止。
 * - complete：total() 总超时 race（覆盖连接 + body 读取）；
 * - stream：next() 块间空闲看门狗，每次迭代重置；
 * - 流后 throwIfAborted()：SDK 流被 abort 时静默 return 不抛错，必须主动判定。
 */
export class AttemptGuard {
  readonly timeoutMs: number;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timeoutFired = false;
  private detachParentListener: (() => void) | undefined;
  readonly signal: AbortSignal;

  constructor(parent: AbortSignal | undefined, timeoutMs: number) {
    this.timeoutMs = Math.max(1, timeoutMs);
    this.signal = this.controller.signal;
    if (parent?.aborted) this.controller.abort(parent.reason);
    else if (parent) {
      // 父 signal 可能横跨整个 run 被大量请求复用，监听器必须随 dispose 解除，
      // 否则闭包持有的 guard/controller 滞留到父 signal 触发（Node 会在同一
      // signal 累积 10+ 监听器时打 AbortSignal memory leak 警告）。
      const onParentAbort = () => this.controller.abort(parent.reason);
      parent.addEventListener("abort", onParentAbort, { once: true });
      this.detachParentListener = () => parent.removeEventListener("abort", onParentAbort);
    }
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /** SDK 请求选项（每请求显式关掉 SDK 重试与超时自管，超时口径归本守卫）。 */
  requestOptions(): { signal: AbortSignal; timeout: number; maxRetries: 0 } {
    return { signal: this.signal, timeout: this.timeoutMs, maxRetries: 0 };
  }

  /** 总超时 race：超时先抛 ExternalCallTimeoutError 再中止连接（abort 会立刻触发 SDK 侧拒绝，顺序反了会抢跑）。 */
  total<T>(promise: Promise<T>): Promise<T> {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      this.timer = setTimeout(() => {
        this.timeoutFired = true;
        const timeout = new ExternalCallTimeoutError(this.timeoutMs);
        reject(timeout);
        this.controller.abort(timeout);
      }, this.timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  /** 块间空闲看门狗：对 iterator.next() 的每次等待单独计时。 */
  async next<T>(pending: Promise<IteratorResult<T>>): Promise<IteratorResult<T>> {
    if (this.timer) clearTimeout(this.timer);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      this.timer = setTimeout(() => {
        this.timeoutFired = true;
        const timeout = new ExternalCallTimeoutError(this.timeoutMs);
        reject(timeout);
        this.controller.abort(timeout);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([pending, timeoutPromise]);
    } finally {
      if (this.timer) clearTimeout(this.timer);
    }
  }

  /** 流循环结束后判定：看门狗超时 > 调用方中止，其余原样放行（pi-ai 三层 abort 同型）。 */
  throwIfAborted(): void {
    if (this.timeoutFired) throw new ExternalCallTimeoutError(this.timeoutMs);
    if (this.aborted) throw this.abortReason() ?? new DOMException("Aborted", "AbortError");
  }

  /** SDK 错误 → 策略层错误族。abort 优先还原原因（AbortError/超时），保住上层语义。 */
  normalize(error: unknown): unknown {
    // 已具超时/重试语义的错误（含"已产出后中断"包装，cause 即超时错误）不二次归一。
    if (error instanceof ExternalCallTimeoutError || error instanceof RetryableHttpError) return error;
    if ((error as { cause?: unknown })?.cause instanceof ExternalCallTimeoutError) return error;
    if (this.timeoutFired) return new ExternalCallTimeoutError(this.timeoutMs);
    if (this.aborted) return this.abortReason() ?? error;
    const status = (error as { status?: unknown })?.status;
    if (typeof status === "number" && isRetryableHttpStatus(status)) {
      return new RetryableHttpError(status, errorMessage(error));
    }
    if (error instanceof OpenAiConnectionTimeoutError || error instanceof AnthropicConnectionTimeoutError) {
      return new ExternalCallTimeoutError(this.timeoutMs);
    }
    // 网络层失败：SDK 包成 APIConnectionError（非 TypeError），还原成 TypeError 保持
    // isRetryableExternalError 的既有重试判定。
    if (error instanceof OpenAiConnectionError || error instanceof AnthropicConnectionError) {
      return new TypeError(errorMessage(error), { cause: error });
    }
    return error;
  }

  private abortReason(): unknown {
    return this.controller.signal.reason;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.detachParentListener?.();
  }
}

/**
 * 守卫 + 错误归一的统一入口：适配器把 SDK 交互整体包进 run，异常在边界归一为
 * 策略层可判定的错误族（ExternalCallTimeoutError / RetryableHttpError / TypeError）。
 */
export async function withProviderGuards<T>(
  request: LlmRequest,
  signal: AbortSignal | undefined,
  run: (guard: AttemptGuard) => Promise<T>,
): Promise<T> {
  const guard = new AttemptGuard(signal, providerTimeoutMs(request));
  try {
    return await run(guard);
  } catch (error) {
    throw guard.normalize(error);
  } finally {
    guard.dispose();
  }
}

export function providerTimeoutMs(request: LlmRequest): number {
  return providerCallPolicy(request.provider).timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_SECONDS * 1000;
}

/** 手动迭代中途退出（stop 控制/interrupted）时触发 SDK 流的 finally，abort 底层请求释放连接。 */
export async function settleAsyncIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // 清理失败不影响调用结果
  }
}

export async function consumeProviderStream<T>(
  onChunk: LlmStreamHandler,
  read: (guardedOnChunk: LlmStreamHandler) => Promise<T>,
): Promise<T> {
  let outputStarted = false;
  try {
    return await read(async (chunk) => {
      if (chunk.content || chunk.reasoning || (chunk.toolCalls?.length ?? 0) > 0) outputStarted = true;
      return onChunk(chunk);
    });
  } catch (error) {
    if (outputStarted && isRetryProviderError(error)) {
      throw new Error(`LLM stream interrupted after output started: ${errorMessage(error)}`, { cause: error });
    }
    throw error;
  }
}

function isRetryProviderError(error: unknown): boolean {
  return error instanceof ExternalCallTimeoutError
    || error instanceof RetryableHttpError
    || (error instanceof TypeError && error.name !== "AbortError");
}

/** 注入 openai/anthropic SDK 的 fetch：仅 ipc_socket 组网时启用，默认走 SDK 自带 fetch。 */
export type ProviderFetch = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

/**
 * SDK fetch 统一解析口：ipc_socket 组网与线级抓取（wire-capture，开发基础设施，
 * env/程序化开关，默认零开销）正交组合。未启用任何一项时返回 undefined，
 * SDK 走自带 fetch——测试 stub globalThis.fetch 依赖这一点（包装层惰性读取
 * globalThis.fetch，stub 语义不变）。
 */
export function resolveSdkFetch(provider: ProviderConfig): ProviderFetch | undefined {
  const ipc = createIpcFetch(provider);
  if (!isWireCaptureEnabled()) return ipc;
  const base = ipc ?? ((input: Request | URL | string, init?: RequestInit) => globalThis.fetch(input, init));
  return wrapFetchWithWireCapture(base, { provider: String(provider.key ?? provider.name ?? provider.provider_type) });
}

export function createIpcFetch(provider: ProviderConfig): ProviderFetch | undefined {
  const transport = provider.transport;
  if (!transport || transport.type !== "ipc_socket") return undefined;
  // 配置预检在构造期完成：注入的 fetch 里抛的错会被 SDK 包装成 APIConnectionError，错误语义丢失。
  const socketPath = requireIpcSocketPath(provider);
  return (input, init) => fetchOverIpcSocket(provider, socketPath, String(input), init ?? {});
}

function requireIpcSocketPath(provider: ProviderConfig): string {
  const transport = provider.transport;
  if (!transport || transport.type !== "ipc_socket") {
    throw new Error(`Provider '${provider.name}' is missing IPC socket transport configuration`);
  }
  const envName = transport.socket_env.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error(`Provider '${provider.name}' has an invalid IPC socket environment variable`);
  }
  const socketPath = process.env[envName]?.trim();
  if (!socketPath) {
    throw new Error(`Provider '${provider.name}' IPC socket environment variable '${envName}' is not configured`);
  }
  return socketPath;
}

function circuitKey(request: LlmRequest): string {
  const provider = request.provider;
  return `provider:${provider.key ?? provider.name ?? provider.provider_type}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown provider error");
}

function fetchOverIpcSocket(
  provider: ProviderConfig,
  socketPath: string,
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  const target = new URL(endpoint);
  if (target.protocol !== "http:") {
    throw new Error(`Provider '${provider.name}' IPC socket endpoint must use the http: scheme`);
  }

  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = requestHttp({
      socketPath,
      path: `${target.pathname}${target.search}`,
      method: init.method ?? "GET",
      headers: { host: target.host, ...headers },
      ...(init.signal ? { signal: init.signal } : {}),
    }, (response) => {
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage ?? "",
        headers: responseHeaders(response.headers),
      }));
    });
    request.once("error", reject);
    if (init.body === undefined || init.body === null) {
      request.end();
      return;
    }
    if (typeof init.body === "string" || init.body instanceof Uint8Array) {
      request.end(init.body);
      return;
    }
    request.destroy(new Error(`Provider '${provider.name}' IPC socket transport only supports buffered request bodies`));
  });
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) result.append(name, entry);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

/** openai SDK baseURL：容忍已带方法后缀的存量配置（SDK 自己拼 /chat/completions、/responses）。 */
export function openAiBaseURL(provider: ProviderConfig, methodSuffix: "/chat/completions" | "/responses"): string {
  const configured = String(provider.api_endpoint ?? DEFAULT_ENDPOINTS[provider.provider_type] ?? "").trim();
  if (!configured) throw new Error(`Provider '${provider.name}' is missing api_endpoint`);
  const base = configured.replace(/\/+$/, "");
  return base.endsWith(methodSuffix) ? base.slice(0, -methodSuffix.length) : base;
}

/** anthropic SDK baseURL：SDK 自拼 /v1/messages，剥离存量配置里的方法/版本段防翻倍。 */
export function anthropicBaseURL(provider: ProviderConfig): string {
  const configured = String(provider.api_endpoint ?? DEFAULT_ENDPOINTS.anthropic ?? "").trim();
  if (!configured) throw new Error(`Provider '${provider.name}' is missing api_endpoint`);
  const base = configured
    .replace(/\/+$/, "")
    .replace(/\/v1\/messages$/, "")
    .replace(/\/messages$/, "")
    .replace(/\/v1$/, "");
  return base || "https://api.anthropic.com";
}

/** genai baseUrl：保留版本段（配 apiVersion:"" 一起用），剥掉尾部方法段/模型段防重复。 */
export function geminiBaseURL(provider: ProviderConfig): string {
  const configured = String(provider.api_endpoint ?? DEFAULT_ENDPOINTS.gemini ?? "").trim();
  if (!configured) throw new Error(`Provider '${provider.name}' is missing api_endpoint`);
  return configured
    .replace(/\/+$/, "")
    // 存量配置可能填到完整方法 URL（…/models/<model>:generateContent?alt=sse）——
    // 模型由参数传入，这里剥掉方法段与模型段，SDK 自行重拼。
    .replace(/:(streamGenerateContent|generateContent)$/, "")
    .replace(/\/models\/[^/]+$/, "")
    .replace(/\/models$/, "");
}
