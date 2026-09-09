/**
 * 线级传输原语（@ai-sdk/provider-utils 委托）：JSON POST / SSE 解析的统一入口。
 * 方言语义（body 构造、流事件分派）仍在各适配器；本层只持传输三件事：
 * - 失败路径直接产出策略层错误族——RetryableHttpError（可重试状态码）或组合了
 *   状态码与响应体详情的普通 Error——绕开 provider-utils 的 schema 化 handler，
 *   错误消息与旧厂商 SDK（"${status} ${body}"）同构；
 * - fetch 惰性解析：未注入（非 ipc/未开线级抓取）时不传，provider-utils 默认参数
 *   在调用时取 globalThis.fetch——测试 stub 语义不变；
 * - SSE 切帧用 eventsource-parser（provider-utils 内部同库），SSE 约定下沉本层：
 *   [DONE] 哨兵终结迭代、畸形 JSON 抛非重试错误（旧厂商 SDK 同语义）、合法非对象
 *   载荷跳过（旧路径 isRecord 守卫同效），方言侧只见到事件 record。
 */
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { APICallError } from "@ai-sdk/provider";
import { postToApi, type ResponseHandler } from "@ai-sdk/provider-utils";
import { isRetryableHttpStatus, RetryableHttpError } from "../external-call-policy.js";
import { isRecord } from "../internal/records.js";
import { extractErrorMessage, type ProviderFetch } from "../transport.js";

export interface WireCallOptions {
  url: string;
  /** 鉴权/协议头在前，provider 自定义头在后（自定义可覆盖，与旧 SDK defaultHeaders 语义一致）。 */
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal;
  /** ipc_socket/线级抓取注入；undefined = 惰性 globalThis.fetch。 */
  fetch: ProviderFetch | undefined;
}

/**
 * postToApi（而非 postJsonToApi 糖衣）：失败 handler 的错误类型不被钉死为
 * APICallError，可直出策略层错误族；Content-Type 与 JSON 序列化在此自理。
 */
async function postWire<T>(options: WireCallOptions, successfulResponseHandler: ResponseHandler<T>): Promise<T> {
  const { value } = await postToApi<T>({
    url: options.url,
    headers: { "Content-Type": "application/json", ...options.headers },
    body: { content: JSON.stringify(options.body), values: options.body },
    abortSignal: options.signal,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    failedResponseHandler: wireFailedResponseHandler,
    successfulResponseHandler,
  });
  return value;
}

/** 非流式：POST → 解析后的 JSON 响应体。 */
export async function postWireJson(options: WireCallOptions): Promise<Record<string, unknown>> {
  return postWire(options, wireJsonBodyHandler);
}

/** 流事件 record 迭代器（SSE data 已解析；提前退出时经 return() 释放底层连接）。 */
export type WireEventStream = AsyncGenerator<Record<string, unknown>, void, void>;

/** 流式：POST → SSE 事件 record 迭代器。 */
export async function postWireSse(options: WireCallOptions): Promise<WireEventStream> {
  return postWire(options, wireSseBodyHandler);
}

// ────────────────────────────── response handlers ──────────────────────────────

/** 非流式成功路径：响应体 → JSON。畸形体抛 APICallError（postToApi 对其实例原样放行，消息不被包装）。 */
const wireJsonBodyHandler = async ({ response, url }: { response: Response; url: string }): Promise<{ value: Record<string, unknown> }> => {
  const text = await response.text();
  try {
    return { value: JSON.parse(text) as Record<string, unknown> };
  } catch (error) {
    throw new APICallError({
      message: `Provider returned a non-JSON response: ${text.slice(0, 200)}`,
      url,
      requestBodyValues: undefined,
      statusCode: response.status,
      responseBody: text,
      cause: error,
    });
  }
};

/** 流式成功路径：响应体交给 SSE 切帧迭代器（错误发生在迭代期，不经 handler 包装）。 */
const wireSseBodyHandler = async ({ response, url }: { response: Response; url: string }): Promise<{ value: WireEventStream }> => {
  if (response.body == null) {
    throw new APICallError({
      message: "Provider streaming response has no body",
      url,
      requestBodyValues: undefined,
      statusCode: response.status,
    });
  }
  return { value: sseRecordEvents(response.body) };
};

/**
 * 失败路径：状态码 + 响应体详情组合消息，可重试状态码直出 RetryableHttpError，
 * 非重试错误挂 statusCode 属性（归一层/下游诊断读 status/statusCode 字段）。
 * 返回（而非抛出）错误实例，postToApi 原样 throw，不经 APICallError 包装。
 */
const wireFailedResponseHandler = async ({ response }: { response: Response }): Promise<{ value: Error }> => {
  const text = await response.text().catch(() => "");
  const detail = extractErrorMessage(parseJsonRecord(text)) ?? (text.trim() || response.statusText);
  const message = `${response.status} ${detail}`.trim();
  if (isRetryableHttpStatus(response.status)) {
    return { value: new RetryableHttpError(response.status, message) };
  }
  const error: Error & { statusCode: number } = Object.assign(new Error(message), { statusCode: response.status });
  return { value: error };
};

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 响应体字节流 → SSE 事件 record。读循环内逐块 feed 解析器（跨块事件自动续接），
 * 完整事件经 drain 转出；finally 取消 reader 释放底层连接（消费方提前 return()/
 * 抛错时沿生成器 finally 触发）。drain 返回 true 表示遇到 [DONE] 哨兵，外层终结。
 */
async function* sseRecordEvents(body: ReadableStream<Uint8Array>): WireEventStream {
  const queue: string[] = [];
  const parser = createParser({
    onEvent: (event: EventSourceMessage) => {
      queue.push(event.data);
    },
  });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const drain = function* (): Generator<Record<string, unknown>, boolean, void> {
    while (queue.length) {
      const data = queue.shift()!;
      if (data === "[DONE]") return true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new Error(`LLM stream sent malformed server-sent event JSON: ${data.slice(0, 120)}`);
      }
      if (isRecord(parsed)) yield parsed;
    }
    return false;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      if (yield* drain()) return;
    }
    parser.feed(decoder.decode());
    yield* drain();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
