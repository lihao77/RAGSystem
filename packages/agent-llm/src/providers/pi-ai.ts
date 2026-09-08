/**
 * pi-ai 委托引擎：provider 声明 llm_engine:"pi-ai" 时接管请求（缺省走原生适配器）。
 * 协议实现与厂商兼容补丁外包给 @earendil-works/pi-ai（dsh 同款姿势：自有契约不动，
 * 协议脏活委托），本文件只做两侧翻译：ProviderConfig → createProvider 单模型手写网关、
 * LlmRequest → Context/SimpleStreamOptions、AssistantMessageEventStream → onChunk/LlmResult。
 * 依赖懒加载：不用该引擎的部署不加载 pi-ai 及其传递依赖（AWS SDK 等）。
 *
 * 与原生路径的语义差异（有意为之，接入前须知）：
 * - usage：pi 侧 input 不含缓存读写（disjoint），此处还原 inclusive 口径
 *   （inputTokens = input + cacheRead + cacheWrite，与原生 anthropic 提取一致）；
 * - 回放：不产出 providerContinuation——历史 assistant 的 reasoningBlocks 在调用边界
 *   重建 pi thinking 块（含 signature / redacted），持久化形状零变化；
 * - extra_params 经 samplingParams 透传，仅 openai 系 pi 适配器消费（pi 能力边界）；
 * - toggle 思考形状（无模型 effort 子集）不支持，显式报错不静默；budget 形状走 pi
 *   预算模式，thinkingBudgets 用我方预设阶梯对齐 BUDGET_BY_LEVEL；
 * - complete 亦走流式 wire（pi 无独立非流式入口），总超时由 AttemptGuard 兜底。
 */
import type {
  ChatMessage,
  ChatToolCall,
  LlmRequest,
  LlmResult,
  LlmStreamHandler,
  ProviderConfig,
  ReasoningBlock,
} from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import { extractText, parseDataUrl, toContentParts } from "../content-parts.js";
import { describeThinking, type ThinkingLevel } from "../thinking.js";
import {
  anthropicBaseURL,
  consumeProviderStream,
  executeProviderOperation,
  geminiBaseURL,
  openAiBaseURL,
  requireApiKey,
  resolveSdkFetch,
  settleAsyncIterator,
  withProviderGuards,
  type AttemptGuard,
} from "../transport.js";
import { isRetryableHttpStatus, RetryableHttpError } from "../external-call-policy.js";

/** pi-ai 引擎声明值（provider.llm_engine）；其余值/缺省 = 原生适配器。 */
export const PI_AI_ENGINE = "pi-ai";

export function isPiAiEngine(provider: ProviderConfig): boolean {
  return (provider as Record<string, unknown>).llm_engine === PI_AI_ENGINE;
}

// ────────────────────────────── pi-ai 懒加载 ──────────────────────────────

interface PiApiModule {
  stream: unknown;
  streamSimple: unknown;
}

const PI_API_BY_FORMAT: Readonly<Record<string, string>> = {
  anthropic: "anthropic-messages",
  openai_resp: "openai-responses",
  openai_chat: "openai-completions",
  gemini: "google-generative-ai",
};

let createProviderLoader: Promise<{ createProvider: (options: unknown) => PiProvider }> | null = null;
const apiModuleCache = new Map<string, Promise<PiApiModule>>();

function loadCreateProvider() {
  createProviderLoader ??= import("@earendil-works/pi-ai").then((m) => m as unknown as { createProvider: (options: unknown) => PiProvider });
  return createProviderLoader;
}

function loadApiModule(format: string): Promise<PiApiModule> {
  let loader = apiModuleCache.get(format);
  if (!loader) {
    loader = import(`@earendil-works/pi-ai/api/${PI_API_BY_FORMAT[format]}`).then((m) => m as unknown as PiApiModule);
    apiModuleCache.set(format, loader);
  }
  return loader;
}

// ────────────────────────────── 运行时（翻译后的 pi provider） ──────────────────────────────

/** pi 侧对象按结构使用（其类型不出现在本包公共 API 面）。 */
interface PiProvider {
  streamSimple(model: unknown, context: unknown, options?: unknown): PiEventStream;
}
interface PiEventStream extends AsyncIterable<Record<string, unknown>> {}
interface PiMessage {
  content: Array<Record<string, unknown>>;
  usage?: Record<string, unknown>;
  stopReason?: string;
  errorMessage?: string;
}

interface PiRuntime {
  provider: PiProvider;
  model: Record<string, unknown>;
  /** 翻译期已解析的思考形状（effort/budget/none；toggle 在解析期已拒绝）。 */
  thinkingKind: "effort" | "budget" | "none";
}

const runtimeCache = new Map<string, { fingerprint: string; runtime: PiRuntime }>();
const RUNTIME_CACHE_LIMIT = 32;

/** budget 形状的档位预算（对齐原生 BUDGET_BY_LEVEL 的 pi thinkingBudgets 表；xhigh/max 无 pi 预算落点由其就近钳制）。 */
const PI_THINKING_BUDGETS = { minimal: 2048, low: 4096, medium: 16384, high: 32768 };

function piBaseUrl(provider: ProviderConfig, format: string): string {
  switch (format) {
    case "anthropic": return anthropicBaseURL(provider);
    case "openai_resp": return openAiBaseURL(provider, "/responses");
    case "openai_chat": return openAiBaseURL(provider, "/chat/completions");
    case "gemini": return geminiBaseURL(provider);
    default: throw new Error(`pi-ai 引擎不支持 API 格式 '${format}'（支持: ${Object.keys(PI_API_BY_FORMAT).join("/")}）`);
  }
}

function thinkingKindOf(provider: ProviderConfig): unknown {
  return (provider as Record<string, unknown>).thinking_kind;
}
function levelsSubsetOf(provider: ProviderConfig): unknown {
  return (provider as Record<string, unknown>).thinking_levels;
}

async function resolvePiRuntime(request: LlmRequest): Promise<PiRuntime> {
  const provider = request.provider;
  const format = provider.provider_type;
  if (!PI_API_BY_FORMAT[format]) {
    throw new Error(`pi-ai 引擎不支持 API 格式 '${format}'（支持: ${Object.keys(PI_API_BY_FORMAT).join("/")}）`);
  }
  const { kind, levels } = describeThinking(format, thinkingKindOf(provider), levelsSubsetOf(provider));
  if (kind === "toggle") {
    throw new Error("pi-ai 引擎暂不支持 toggle 思考形状（模型无 effort 子集）；请将 thinking_kind 改为 effort/budget 或清除");
  }
  if (request.thinkingLevel && !levels.includes(request.thinkingLevel)) {
    throw new Error(`thinking level "${request.thinkingLevel}" is not supported by pi-ai engine provider "${provider.name}" (available: ${levels.join("/")})`);
  }
  const baseUrl = piBaseUrl(provider, format);
  const piProviderId = `ragsystem:${provider.key ?? provider.name}`;
  // 指纹不含 api_key（密钥按请求经 options.apiKey 注入）；配置变更指纹不符即重建。
  const fingerprint = JSON.stringify([
    piProviderId, format, baseUrl, kind, levels, provider.supports_vision,
    provider.max_completion_tokens, provider.max_tokens, provider.max_context_tokens, request.model,
  ]);
  const cacheKey = provider.key ?? provider.name;
  const cached = runtimeCache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) return cached.runtime;

  const strength = levels.filter((level) => level !== "off") as ThinkingLevel[];
  const model: Record<string, unknown> = {
    id: request.model,
    name: request.model,
    api: PI_API_BY_FORMAT[format],
    provider: piProviderId,
    baseUrl,
    reasoning: kind !== "none",
    ...(strength.length ? { thinkingLevelMap: Object.fromEntries(strength.map((level) => [level, level])) } : {}),
    input: provider.supports_vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: provider.max_context_tokens ?? 128000,
    maxTokens: provider.max_completion_tokens ?? provider.max_tokens ?? 16384,
    ...(format === "anthropic" && kind === "effort" ? { compat: { forceAdaptiveThinking: true } } : {}),
  };
  const [pi, api] = await Promise.all([loadCreateProvider(), loadApiModule(format)]);
  const piProvider = pi.createProvider({
    id: piProviderId,
    name: provider.name || piProviderId,
    baseUrl,
    auth: { apiKey: { name: provider.name || piProviderId, resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream: api.stream, streamSimple: api.streamSimple },
  });
  const runtime: PiRuntime = { provider: piProvider, model, thinkingKind: kind as PiRuntime["thinkingKind"] };
  if (runtimeCache.size >= RUNTIME_CACHE_LIMIT) runtimeCache.clear();
  runtimeCache.set(cacheKey, { fingerprint, runtime });
  return runtime;
}

// ────────────────────────────── 请求翻译 ──────────────────────────────

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** content → pi 内容块（text 直通；图片 data URL 解 base64，http(s) 现场拉取转 base64）。 */
async function toPiContent(message: ChatMessage): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of toContentParts(message.content ?? "")) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        blocks.push({ type: "image", data: parsed.base64, mimeType: parsed.mediaType });
      } else {
        const response = await fetch(part.image_url.url);
        if (!response.ok) throw new Error(`pi-ai 引擎拉取图片失败: ${part.image_url.url} (HTTP ${response.status})`);
        blocks.push({ type: "image", data: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType: response.headers.get("content-type") ?? "image/png" });
      }
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 历史 assistant 的推理块 → pi thinking 块（签名/redacted 原样，空块丢弃）。 */
function toPiThinkingBlocks(blocks: ReasoningBlock[] | undefined): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const block of blocks ?? []) {
    if (block.type === "redacted_thinking") {
      output.push({ type: "thinking", thinking: "", thinkingSignature: block.data, redacted: true });
    } else if (block.thinking.trim() || block.signature) {
      output.push({ type: "thinking", thinking: block.thinking, ...(block.signature ? { thinkingSignature: block.signature } : {}) });
    }
  }
  return output;
}

async function buildPiContext(request: LlmRequest, piProviderId: string, apiId: string): Promise<Record<string, unknown>> {
  const systemPrompt = request.messages
    .filter((message) => message.role === "system")
    .map((message) => extractText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const toolNameById = new Map<string, string>();
  for (const message of request.messages) {
    for (const call of message.tool_calls ?? []) toolNameById.set(call.id, call.function.name);
  }
  const messages: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      messages.push({ role: "user", content: await toPiContent(message), timestamp: 0 });
    } else if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [
        ...toPiThinkingBlocks(message.reasoning_blocks),
        ...toContentParts(message.content ?? "").filter((part) => part.type === "text" && part.text).map((part) => ({ type: "text", text: (part as { text: string }).text })),
        ...(message.tool_calls ?? []).map((call) => ({ type: "toolCall", id: call.id, name: call.function.name, arguments: parseArguments(call.function.arguments) })),
      ];
      messages.push({
        role: "assistant",
        content: content.length ? content : [{ type: "text", text: "" }],
        api: apiId,
        provider: piProviderId,
        model: request.model,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: 0,
      });
    } else {
      messages.push({
        role: "toolResult",
        toolCallId: message.tool_call_id ?? "",
        toolName: toolNameById.get(message.tool_call_id ?? "") ?? message.tool_call_id ?? "",
        content: await toPiContent(message),
        isError: false,
        timestamp: 0,
      });
    }
  }
  const tools = request.tools?.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters,
  }));
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages,
    ...(tools?.length ? { tools } : {}),
  };
}

function buildPiOptions(request: LlmRequest, runtime: PiRuntime, signal: AbortSignal): Record<string, unknown> {
  const fetchImpl = resolveSdkFetch(request.provider);
  const level = request.thinkingLevel;
  return {
    apiKey: requireApiKey(request.provider),
    signal,
    ...(level && level !== "off" ? { reasoning: level } : {}),
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
    maxTokens: request.maxCompletionTokens ?? request.provider.max_completion_tokens ?? request.provider.max_tokens ?? (runtime.model.maxTokens as number),
    ...(request.tools?.length && request.toolChoice ? { toolChoice: request.toolChoice } : {}),
    ...(request.extraParams && Object.keys(request.extraParams).length ? { samplingParams: request.extraParams } : {}),
    ...(request.promptCacheKey ? { sessionId: request.promptCacheKey } : {}),
    ...(runtime.thinkingKind === "budget" ? { thinkingBudgets: PI_THINKING_BUDGETS } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

// ────────────────────────────── 响应翻译 ──────────────────────────────

const FINISH_BY_STOP_REASON: Readonly<Record<string, string>> = {
  stop: "stop",
  length: "length",
  toolUse: "tool_calls",
  deferred: "deferred",
  aborted: "aborted",
  error: "error",
};

/** pi Usage（disjoint：input 不含缓存）→ 我方 TokenUsage（inclusive）。 */
export function piUsageToTokenUsage(usage: Record<string, unknown> | undefined): LlmResult["usage"] {
  const input = Number(usage?.input ?? 0) || 0;
  const output = Number(usage?.output ?? 0) || 0;
  const cacheRead = Number(usage?.cacheRead ?? 0) || 0;
  const cacheWrite = Number(usage?.cacheWrite ?? 0) || 0;
  const inputTokens = input + cacheRead + cacheWrite;
  return {
    inputTokens,
    outputTokens: output,
    totalTokens: Number(usage?.totalTokens ?? 0) || inputTokens + output,
    ...(cacheRead ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheCreationInputTokens: cacheWrite } : {}),
  };
}

function piToolCallToOurs(call: Record<string, unknown>): ChatToolCall {
  return {
    id: String(call.id ?? ""),
    type: "function",
    function: { name: String(call.name ?? ""), arguments: JSON.stringify(call.arguments ?? {}) },
  };
}

function toLlmResult(message: PiMessage, request: LlmRequest): LlmResult {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const textBlocks = blocks.filter((block) => block.type === "text");
  const thinkingBlocks = blocks.filter((block) => block.type === "thinking");
  const toolCallBlocks = blocks.filter((block) => block.type === "toolCall");
  const content = textBlocks.map((block) => String(block.text ?? "")).join("");
  const reasoning = thinkingBlocks.filter((block) => !block.redacted).map((block) => String(block.thinking ?? "")).join("");
  const reasoningBlocks: ReasoningBlock[] = [];
  for (const block of thinkingBlocks) {
    if (block.redacted) {
      if (block.thinkingSignature) reasoningBlocks.push({ type: "redacted_thinking", data: String(block.thinkingSignature) });
    } else if (block.thinking || block.thinkingSignature) {
      reasoningBlocks.push({ type: "thinking", thinking: String(block.thinking ?? ""), signature: String(block.thinkingSignature ?? "") });
    }
  }
  const toolCalls = toolCallBlocks.map(piToolCallToOurs);
  const finishReason = message.stopReason ? (FINISH_BY_STOP_REASON[message.stopReason] ?? message.stopReason) : null;
  if (!content && !reasoningBlocks.length && !toolCalls.length && !request.allowEmptyStream) {
    throw new Error(`pi-ai stream response did not include assistant content (stopReason=${message.stopReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, finishReason, raw: message as unknown as Record<string, unknown> };
  if (reasoning) result.reasoning = reasoning;
  if (reasoningBlocks.length) result.reasoningBlocks = reasoningBlocks;
  if (toolCalls.length) result.toolCalls = toolCalls;
  const usage = piUsageToTokenUsage(message.usage);
  if (usage) result.usage = usage;
  return result;
}

// ────────────────────────────── 适配器 ──────────────────────────────

export class PiAiAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) =>
        guard.total(runPiStream(request, guard, async () => {})),
      ),
    );
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) =>
        consumeProviderStream(onChunk, (emit) => runPiStream(request, guard, emit)),
      ),
    );
  }
}

/**
 * pi-ai 的失败经 in-band error 事件交付（errorMessage 是纯字符串，原始 SDK 错误
 * 实例被 pi 侧 catch 吞掉），策略层按形态识别的可重试分类（APIConnectionError →
 * TypeError、HTTP 状态 → RetryableHttpError）在此丢失，瞬时网络抖动会零重试直达
 * 用户。这里按字符串形态重建同一套分类，对齐原生路径的重试语义。
 */
const PI_CONNECTION_ERROR_PATTERNS: readonly RegExp[] = [
  /^connection error/i, // anthropic/openai SDK APIConnectionError 默认消息
  /^request timed out/i, // SDK APIConnectionTimeoutError
  /^fetch failed/i,
  /^terminated/i, // undici 响应体中断（裸消息；限定行首避免误伤厂商侧"...terminated by..."文案）
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)\b/i,
  /socket hang up/i,
];

export function piStreamFailureToError(failed: PiMessage): Error {
  const reason = String(failed.stopReason ?? "error");
  const raw = String(failed.errorMessage ?? "unknown error");
  const message = `pi-ai stream failed (${reason}): ${raw}`;
  // abort 不可重试且先于一切形态判定（避免 "529 ..."/"terminated" 类文本撞上 aborted 语义）
  if (reason === "aborted") return new Error(message);
  // anthropic/openai SDK 的 HTTP 错误消息形如 "${status} ${body}"；pi 的 SSE error
  // 事件则把 overloaded_error JSON 原样抛出（无状态码），按 529 归入可重试。
  const statusMatch = /^\s*(\d{3})(?:\s|$)/.exec(raw);
  if (statusMatch && isRetryableHttpStatus(Number(statusMatch[1]))) {
    return new RetryableHttpError(Number(statusMatch[1]), message);
  }
  if (/"type"\s*:\s*"overloaded_error"/.test(raw)) {
    return new RetryableHttpError(529, message);
  }
  if (PI_CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(raw))) {
    return new TypeError(message);
  }
  return new Error(message);
}

/** 消费 pi 事件流：text/thinking/toolcall 增量转 chunk，终态消息转 LlmResult。 */
async function runPiStream(request: LlmRequest, guard: AttemptGuard, emit: LlmStreamHandler): Promise<LlmResult> {
  const runtime = await resolvePiRuntime(request);
  const piProviderId = String(runtime.model.provider);
  const apiId = String(runtime.model.api);
  const context = await buildPiContext(request, piProviderId, apiId);
  const options = buildPiOptions(request, runtime, guard.signal);
  const stream = runtime.provider.streamSimple(runtime.model, context, options);
  const iterator = stream[Symbol.asyncIterator]();
  let stopped = false;
  let finalMessage: PiMessage | null = null;
  let failed: PiMessage | null = null;
  const emitChecked = async (chunk: Parameters<LlmStreamHandler>[0]) => {
    if (stopped) return;
    const control = await emit(chunk);
    if (control?.stop) stopped = true;
  };
  try {
    while (true) {
      const result = await guard.next(iterator.next());
      if (result.done) break;
      const event = result.value;
      const type = String(event.type ?? "");
      if (type === "text_delta" && typeof event.delta === "string") {
        await emitChecked({ content: event.delta, raw: event });
      } else if (type === "thinking_delta" && typeof event.delta === "string") {
        await emitChecked({ content: "", reasoning: event.delta, raw: event });
      } else if (type === "toolcall_end" && event.toolCall && typeof event.toolCall === "object") {
        await emitChecked({ content: "", toolCalls: [piToolCallToOurs(event.toolCall as Record<string, unknown>)], raw: event });
      } else if (type === "done") {
        finalMessage = event.message as PiMessage;
      } else if (type === "error") {
        failed = event.error as PiMessage;
      }
      if (stopped) break;
    }
    guard.throwIfAborted();
  } finally {
    await settleAsyncIterator(iterator);
  }
  if (failed) {
    throw piStreamFailureToError(failed);
  }
  if (!finalMessage) {
    throw new Error(`pi-ai stream ended without a final message${stopped ? " (stopped by consumer)" : ""}`);
  }
  return toLlmResult(finalMessage, request);
}
