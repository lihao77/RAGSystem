/**
 * LLM 线级抓取（开发基础设施）：在 SDK fetch 边界记录"发送的请求 + 收到的原始响应"。
 *
 * 用途：provider usage/缓存字段的口径核对（如网关 usage 字段名不匹配排查）、
 * 线协议形状差异对比、SSE 事件序列检查。抓取的是未经解析的原始 wire 数据——
 * 网关实际返回什么就记什么，与 extractXxxUsage 的解析结果互为对照。
 *
 * 开关（默认关闭，零开销）：
 * - 环境变量 RAGSYSTEM_LLM_WIRE_CAPTURE："1"/"true" 启用（目录默认 <cwd>/llm-wire-logs），
 *   或直接给目录路径（如 D:/test/llm-wire）。
 * - RAGSYSTEM_LLM_WIRE_CAPTURE_PROVIDERS：可选，逗号分隔 provider key 白名单（缺省全抓）。
 * - 程序化：configureWireCapture({ dir, providers })（host 启动期调用，覆盖环境变量）。
 *
 * 产物：目录下按天一个 JSONL（wire-YYYY-MM-DD.jsonl），每次 HTTP 交换两行：
 *   { kind: "request",  id, ts, provider, method, url, headers(脱敏), body }
 *   { kind: "response", id, ts, status, headers(脱敏), stream, body(完整原始文本), interrupted }
 * 流式响应通过 body.tee() 旁路收集：SDK 正常消费一支，抓取异步收另一支，结束后补写
 * response 行；请求中途崩溃/中止时 request 行仍在，response 行标记 interrupted。
 *
 * 安全与注意：
 * - Authorization/x-api-key/api-key 等敏感头值脱敏为 sha256 前 8 位；请求体不脱敏
 *  （可能含用户对话内容），文件落在本地磁盘，仅用于开发调试，不要提交/外发。
 * - 抓取路径上的任何错误都静默吞掉（stderr 记一次），绝不影响真实请求。
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENV_ENABLE = "RAGSYSTEM_LLM_WIRE_CAPTURE";
const ENV_PROVIDERS = "RAGSYSTEM_LLM_WIRE_CAPTURE_PROVIDERS";
const DEFAULT_DIR_NAME = "llm-wire-logs";
const SENSITIVE_HEADER_HINTS = ["authorization", "api-key", "apikey", "token", "cookie"];

export interface WireCaptureOptions {
  /** 抓取文件目录；启用但未给目录时用默认目录。 */
  dir?: string;
  /** provider key 白名单（小写精确匹配）；空数组/缺省 = 全部 provider。 */
  providers?: string[];
}

interface WireCaptureState {
  dir: string;
  providers: Set<string>;
}

let state: WireCaptureState | null = null;
let stateResolved = false;
let warnedOnce = false;
/** 同文件追加串行化：保证 JSONL 行不交错。 */
let appendQueue: Promise<void> = Promise.resolve();

function resolveState(): WireCaptureState | null {
  if (stateResolved) return state;
  stateResolved = true;
  const raw = process.env[ENV_ENABLE]?.trim();
  if (!raw || ["0", "false", "off", "no"].includes(raw.toLowerCase())) return null;
  const dir = ["1", "true", "on", "yes"].includes(raw.toLowerCase())
    ? path.join(process.cwd(), DEFAULT_DIR_NAME)
    : raw;
  const providers = new Set(
    (process.env[ENV_PROVIDERS] ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  state = { dir, providers };
  return state;
}

/** host 启动期程序化配置（优先于环境变量；传 null 关闭）。 */
export function configureWireCapture(options: WireCaptureOptions | null): void {
  stateResolved = true;
  if (!options) {
    state = null;
    return;
  }
  state = {
    dir: options.dir?.trim() || path.join(process.cwd(), DEFAULT_DIR_NAME),
    providers: new Set((options.providers ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean)),
  };
}

export function wireCaptureStatus(): { enabled: boolean; dir: string | null; providers: string[] } {
  const current = resolveState();
  return {
    enabled: current !== null,
    dir: current?.dir ?? null,
    providers: current ? [...current.providers] : [],
  };
}

export function isWireCaptureEnabled(): boolean {
  return resolveState() !== null;
}

/** SDK fetch 包装：请求/响应原样透传，旁路记录 wire 数据。 */
export function wrapFetchWithWireCapture(
  baseFetch: (input: Request | URL | string, init?: RequestInit) => Promise<Response>,
  meta: { provider: string },
): (input: Request | URL | string, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const capture = resolveState();
    if (!capture || !providerSelected(capture, meta.provider)) {
      return baseFetch(input, init);
    }
    try {
      return captureExchange(baseFetch, capture, meta, input, init);
    } catch (error) {
      warnOnce(`wire capture setup failed: ${errorMessage(error)}`);
      return baseFetch(input, init);
    }
  };
}

function providerSelected(capture: WireCaptureState, provider: string): boolean {
  if (capture.providers.size === 0) return true;
  return capture.providers.has(provider.trim().toLowerCase());
}

async function captureExchange(
  baseFetch: (input: Request | URL | string, init?: RequestInit) => Promise<Response>,
  capture: WireCaptureState,
  meta: { provider: string },
  input: Request | URL | string,
  init: RequestInit | undefined,
): Promise<Response> {
  const id = randomUUID();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const headers = redactHeaders(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
  const body = await readRequestBody(init?.body);
  appendJsonl(capture.dir, {
    kind: "request",
    id,
    ts: new Date().toISOString(),
    provider: meta.provider,
    method,
    url,
    headers,
    body,
  });

  let response: Response;
  try {
    response = await baseFetch(input, init);
  } catch (error) {
    appendJsonl(capture.dir, {
      kind: "response",
      id,
      ts: new Date().toISOString(),
      provider: meta.provider,
      error: errorMessage(error),
      interrupted: true,
    });
    throw error;
  }

  if (!response.body) {
    appendJsonl(capture.dir, {
      kind: "response",
      id,
      ts: new Date().toISOString(),
      provider: meta.provider,
      status: response.status,
      headers: redactHeaders(response.headers),
      stream: false,
      body: null,
    });
    return response;
  }

  const [consumerBranch, captureBranch] = response.body.tee();
  void collectStreamTail(capture.dir, id, meta.provider, captureBranch, {
    status: response.status,
    headers: redactHeaders(response.headers),
    contentType: response.headers.get("content-type") ?? "",
  });
  return new Response(consumerBranch, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function collectStreamTail(
  dir: string,
  id: string,
  provider: string,
  branch: ReadableStream<Uint8Array>,
  meta: { status: number; headers: Record<string, string>; contentType: string },
): Promise<void> {
  const decoder = new TextDecoder();
  let collected = "";
  let interrupted = false;
  const reader = branch.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collected += decoder.decode(value, { stream: true });
      // 上限保护：畸形/超长流不至于撑爆磁盘（64MB 足够任何一次 LLM 交换）。
      if (collected.length > 64 * 1024 * 1024) {
        interrupted = true;
        break;
      }
    }
    collected += decoder.decode();
  } catch {
    interrupted = true;
  } finally {
    try {
      reader.releaseLock();
      await branch.cancel().catch(() => undefined);
    } catch {
      // 旁路清理失败不影响主流程
    }
    appendJsonl(dir, {
      kind: "response",
      id,
      ts: new Date().toISOString(),
      provider,
      status: meta.status,
      headers: meta.headers,
      stream: meta.contentType.includes("text/event-stream"),
      body: collected,
      ...(interrupted ? { interrupted: true } : {}),
    });
  }
}

async function readRequestBody(body: unknown): Promise<unknown> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return parseJsonLoose(body);
  if (body instanceof Uint8Array) return parseJsonLoose(new TextDecoder().decode(body));
  if (body instanceof ArrayBuffer) return parseJsonLoose(new TextDecoder().decode(body));
  // SDK 请求体均为序列化后的字符串/字节；流式请求体（duplex）极少见于 LLM 方言，
  // 记个形状占位避免误吞。
  return { opaque: String(body) };
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    result[name] = isSensitiveHeader(name) ? `<redacted:${digest8(value)}>` : value;
  }
  return result;
}

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_HINTS.some((hint) => lower === hint || lower.includes(hint));
}

function digest8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function appendJsonl(dir: string, record: Record<string, unknown>): void {
  appendQueue = appendQueue
    .then(async () => {
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, `wire-${new Date().toISOString().slice(0, 10)}.jsonl`);
        await fs.promises.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
      } catch (error) {
        warnOnce(`wire capture write failed: ${errorMessage(error)}`);
      }
    })
    // 队列永不断裂：单次写失败只丢该行。
    .catch(() => undefined);
}

function warnOnce(message: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.error(`[agent-llm wire-capture] ${message} (后续同类告警静默)`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
