/**
 * 媒体生成 API 共享 HTTP 客户端：超时/取消/错误规整。
 * 所有 adapter 经由此层发请求，测试注入 stub fetch。
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class MediaHttpError extends Error {
  readonly status: number;
  readonly raw: unknown;

  constructor(message: string, status: number, raw: unknown) {
    super(message);
    this.name = "MediaHttpError";
    this.status = status;
    this.raw = raw;
  }
}

export interface HttpOptions {
  method?: "GET" | "POST" | undefined;
  headers?: Record<string, string> | undefined;
  body?: unknown;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | null | undefined;
  fetchImpl?: FetchLike | undefined;
}

/** 把厂商错误响应规整为可读消息（常见字段：error.message / message / msg / detail / code）。 */
function extractErrorMessage(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error !== null && typeof error === "object") {
    const nested = extractErrorMessage(error);
    if (nested) return nested;
  }
  for (const key of ["message", "msg", "detail", "error", "code"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return key === "code" && record.message ? `${String(record.message)} (code: ${value})` : value;
    }
  }
  return null;
}

async function readBody(response: Response): Promise<{ text: string; json: unknown }> {
  const text = await response.text().catch(() => "");
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { text, json };
}

export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<{ status: number; data: T }> {
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await doFetch(url, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
    const { text, json } = await readBody(response);
    if (!response.ok) {
      const message = extractErrorMessage(json) ?? (text.slice(0, 300) || `HTTP ${response.status}`);
      throw new MediaHttpError(`厂商 API 错误 (HTTP ${response.status}): ${message}`, response.status, json ?? text);
    }
    return { status: response.status, data: (json ?? {}) as T };
  } catch (error) {
    if (error instanceof MediaHttpError) throw error;
    if (controller.signal.aborted && !(options.signal?.aborted ?? false)) {
      throw new MediaHttpError(`厂商 API 请求超时（${Math.round((options.timeoutMs ?? 120_000) / 1000)}s）: ${url}`, 408, null);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new MediaHttpError(`厂商 API 请求失败: ${reason}`, 0, null);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function downloadBinary(
  url: string,
  options: HttpOptions = {},
): Promise<{ bytes: Buffer; contentType: string }> {
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await doFetch(url, { method: "GET", headers: options.headers ?? {}, signal: controller.signal });
    if (!response.ok) {
      const { json } = await readBody(response);
      const message = extractErrorMessage(json) ?? `HTTP ${response.status}`;
      throw new MediaHttpError(`媒体下载失败 (HTTP ${response.status}): ${message}`, response.status, json);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      bytes: Buffer.from(arrayBuffer),
      contentType: String(response.headers.get("content-type") ?? "application/octet-stream"),
    };
  } catch (error) {
    if (error instanceof MediaHttpError) throw error;
    if (controller.signal.aborted && !(options.signal?.aborted ?? false)) {
      throw new MediaHttpError(`媒体下载超时: ${url}`, 408, null);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new MediaHttpError(`媒体下载失败: ${reason}`, 0, null);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
