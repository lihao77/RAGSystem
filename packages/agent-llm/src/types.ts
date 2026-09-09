/**
 * @ragsystem/agent-llm —— LLM 通信基金层类型。
 *
 * 与厂商解耦的纯类型 + LlmClient 端口。线协议依托官方 SDK（openai /
 * @anthropic-ai/sdk / @google/genai），本层持有策略（重试/熔断/看门狗）与厂商语义
 * （续传态/思考档位/缓存断点）；可独立使用（不绑 agent 循环）：
 * 消费者可直接用 LlmProviderClient 调模型（complete/stream），无需 agent-sdk。
 *
 * agent-sdk 依赖本包，import 这些类型。LlmRequest 不含 agent——生成参数由消费者解析后传入，
 * LLM 层不做 agent tier 解析（产品逻辑）。
 */

import type { ThinkingLevel } from "./thinking.js";

/** 文本内容片段。 */
export interface TextPart {
  type: "text";
  text: string;
}

/** 图片内容片段（OpenAI image_url 风格；url 用 data URL 或 http(s) URL）。 */
export interface ImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

/** 多模态内容片段（OpenAI 标准 content array 元素）。 */
export type ContentPart = TextPart | ImagePart;

/** 单条聊天消息（LLM 通信核心结构，基金层拥有；agent-sdk 复用）。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  /**
   * 厂商要求在工具调用后原样回传的隐藏推理块。
   * 当前由 Anthropic extended thinking 使用；普通调用无需设置。
   */
  reasoning_blocks?: ReasoningBlock[];
  /** Provider-owned opaque state required only to continue a pending tool transaction. */
  provider_continuation?: ProviderContinuationState;
}

/** 可安全跨工具轮次回传的隐藏推理块（不会进入正文事件流）。 */
export type ReasoningBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/**
 * Opaque continuation state. Consumers must persist and replay payloads without rewriting them.
 * It is not conversation content and must not be exposed in user-facing message metadata.
 */
export type ProviderContinuationState =
  | {
      protocol: "anthropic_messages";
      toolCallIds: string[];
      blocks: ReasoningBlock[];
    }
  | {
      protocol: "openai_responses";
      toolCallIds: string[];
      /** First function call of this round; reasoning items replay immediately before it. Absent on text-only rounds. */
      anchorCallId?: string;
      reasoningItems: Record<string, unknown>[];
    }
  | {
      protocol: "gemini_generate_content";
      toolCallIds: string[];
      /** Candidate parts must be replayed verbatim, including thoughtSignature fields. */
      parts: Record<string, unknown>[];
    }
  | {
      protocol: "openai_chat";
      toolCallIds: string[];
      /** Provider-specific reasoning fields (reasoning_content 等) replayed with the assistant message. */
      assistantFields: Record<string, unknown>;
    };

/** 结构化工具调用（厂商 function calling 产物 / XML 解析重建）。 */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** 下发给厂商 FC 的工具定义。 */
export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
  /** 工具来源标记（runtime_builtin/memory/document/execution/agent_tool/knowledge/mcp），用于上下文构成估算与展示。 */
  source?: string;
}

/**
 * 模型供应商配置（结构化最小集）。
 *
 * 基金层只读它做请求壳（endpoint/key/兜底 max_tokens）+ 厂商分派（provider_type）。
 * backend-ts 的 ModelProviderConfig 结构兼容本类型（超集）。
 */
export interface ProviderConfig {
  key: string | null;
  name: string;
  provider_type: string;
  api_endpoint?: string | null;
  /**
   * 服务端点形态（用户显式声明，缺省 base）：
   * - base = 基座 URL，传输层按协议归一拼装规范方法路径（openai 系剥误粘段后拼
   *   /v1/chat/completions|/responses——裸域名自动补 /v1；anthropic 拼 /v1/messages）；
   * - full = 配置即完整方法 URL 原样直用（根路径网关等非规范布局的逃生通道），
   *   openai 系须以方法段结尾、anthropic 须以 /messages 结尾，失配显式报错
   *   （防误配落回 200+HTML 的空流陷阱）。
   * gemini 不适用（URL 由 SDK 按模型名拼装），配置面拒绝。
   */
  endpoint_mode?: "base" | "full" | null;
  api_key?: string | null;
  /** Optional process-local transport used by trusted local deployment composition. */
  transport?: {
    type: "ipc_socket";
    socket_env: string;
  } | null;
  supports_function_calling?: boolean | null;
  supports_vision?: boolean | null;
  /** Provider prompt cache switch. Defaults on; each adapter emits only fields supported by its protocol. */
  supports_prompt_caching?: boolean | null;
  /** provider KV cache 有效期(秒);memory 前缀快照 sliding 失效阈值用。 */
  cache_ttl_seconds?: number | null;
  max_completion_tokens?: number | null;
  max_tokens?: number | null;
  temperature?: number | null;
  /**
   * 自定义 HTTP 请求头（该 provider 全部 LLM 请求原样附带）：网关侧会话路由/缓存
   * 亲和头（opencode Console Go 的 x-opencode-session、sub2api 的 session_id——
   * 上游 prompt cache 绑定网关侧账号/路由桶，缺稳定会话头会被硬拒或缓存冷启动），
   * 或网关私有标记头。值支持 {session_id} 占位符：调用期解析为本次会话的稳定路由键
   * （= LlmRequest.promptCacheKey），无会话上下文的辅助调用回落 provider 级稳定值——
   * 保证占位符头恒在场，硬性网关（如 Console Go）的辅助调用不被 400。
   */
  headers?: Record<string, string> | null;
  /** 厂商扩展参数（extra_params 等）原样透传给请求 body。 */
  [extra: string]: unknown;
}

export type LlmAttemptLifecycleEvent =
  | {
      phase: "started";
      attemptId: string;
      attempt: number;
      maxAttempts: number;
    }
  | {
      phase: "failed";
      attemptId: string;
      attempt: number;
      maxAttempts: number;
      willRetry: boolean;
      retryDelayMs?: number;
      elapsedMs: number;
      error: string;
    }
  | {
      phase: "completed";
      attemptId: string;
      attempt: number;
      maxAttempts: number;
      elapsedMs: number;
    };

/** 一次 LLM 调用的请求壳（无 agent；参数已由消费者解析）。 */
export interface LlmRequest {
  messages: ChatMessage[];
  model: string;
  provider: ProviderConfig;
  signal?: AbortSignal;
  temperature?: number | null;
  maxCompletionTokens?: number | null;
  /**
   * 请求级思考档位（off/minimal/low/medium/high/xhigh/max/on；厂商枚举子集由 thinking.ts 判定）。
   * 优先于 agent tier 默认档位。不传 → 由协议层以 tier 档位兜底，均无 → 不发送思考参数（模型默认）。
   */
  thinkingLevel?: ThinkingLevel | null;
  tools?: ChatToolDefinition[];
  toolChoice?: "auto" | "none";
  allowEmptyStream?: boolean;
  extraParams?: Record<string, unknown> | null;
  /** Stable, non-sensitive routing key used by providers that support prompt caching. */
  promptCacheKey?: string;
  /** 真实 provider I/O attempt 生命周期；由 transport 在物理重试边界触发。 */
  onAttemptLifecycle?: (event: LlmAttemptLifecycleEvent) => void;
}

/** 一次 LLM 调用的 token 用量（厂商返回的 usage 解析归一化）。 */
export interface TokenUsage {
  /** Logical input occupying the model context window, including cached prompt tokens. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Input tokens served from a provider prompt cache, when reported separately. */
  cachedInputTokens?: number;
  /** Input tokens written to a provider prompt cache, when reported separately. */
  cacheCreationInputTokens?: number;
}

/** 一次 LLM 调用的结果。 */
export interface LlmResult {
  content: string;
  /** 思考模型思维链全文（流式 chunk 增量的累积）；用于空响应判定与 reasoning_complete 快照。 */
  reasoning?: string;
  /** 需随 assistant 工具调用消息原样回传的厂商推理块。 */
  reasoningBlocks?: ReasoningBlock[];
  /** Opaque state to attach to the assistant tool-call message until its continuation succeeds. */
  providerContinuation?: ProviderContinuationState;
  raw?: unknown;
  finishReason?: string | null;
  toolCalls?: ChatToolCall[];
  /** 厂商返回的 token 用量；缺失（部分 provider 不返回）时为 undefined。 */
  usage?: TokenUsage;
}

/** 流式增量 chunk。 */
export interface LlmStreamChunk {
  content: string;
  /** 思考增量（与 content 同为 delta 语义，累积后对应 LlmResult.reasoning）。 */
  reasoning?: string;
  finishReason?: string | null;
  raw?: unknown;
  toolCalls?: ChatToolCall[];
}

/** 流式回调可返回的控制信号（如 stop 提前截断）。 */
export interface LlmStreamControl {
  stop?: boolean;
}

export type LlmStreamHandler = (
  chunk: LlmStreamChunk,
) => void | LlmStreamControl | Promise<void | LlmStreamControl>;

/**
 * LLM 客户端端口。complete 非流式；stream 可选流式。
 * 基金层提供 LlmProviderClient 默认实现（OpenAI/Anthropic/Gemini 等协议）。
 */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResult>;
  stream?(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult>;
}

/** 已解析的生成参数（消费者解析后注入 agent-sdk）。 */
export interface RequestLlmParams {
  temperature: number | null;
  maxCompletionTokens: number | null;
  extraParams: Record<string, unknown>;
  /** tier 默认思考档位（agent 配置）；请求级 thinkingLevel 优先于它。 */
  thinkingLevel?: ThinkingLevel | null;
}
