/**
 * @ragsystem/agent-llm —— LLM 通信基金层类型。
 *
 * 与厂商解耦的纯类型 + LlmClient 端口。零内部依赖、可独立使用（不绑 agent 循环）：
 * 消费者可直接用 OpenAiCompatibleClient 调模型（complete/stream），无需 agent-sdk。
 *
 * agent-sdk 依赖本包，import 这些类型。LlmRequest 不含 agent——生成参数由消费者解析后传入，
 * LLM 层不做 agent tier 解析（产品逻辑）。
 */

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
}

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
  api_key?: string | null;
  supports_function_calling?: boolean | null;
  supports_vision?: boolean | null;
  /** Anthropic 路径 prompt cache 总开关(默认开,!== false 即在 system/tools 尾部打 cache_control)。 */
  supports_prompt_caching?: boolean | null;
  /** provider KV cache 有效期(秒);memory 前缀快照 sliding 失效阈值用。 */
  cache_ttl_seconds?: number | null;
  max_completion_tokens?: number | null;
  max_tokens?: number | null;
  temperature?: number | null;
  /** 厂商扩展参数（extra_params 等）原样透传给请求 body。 */
  [extra: string]: unknown;
}

/** 一次 LLM 调用的请求壳（无 agent；参数已由消费者解析）。 */
export interface LlmRequest {
  messages: ChatMessage[];
  model: string;
  provider: ProviderConfig;
  signal?: AbortSignal;
  temperature?: number | null;
  maxCompletionTokens?: number | null;
  tools?: ChatToolDefinition[];
  toolChoice?: "auto" | "none";
  allowEmptyStream?: boolean;
  extraParams?: Record<string, unknown> | null;
}

/** 一次 LLM 调用的 token 用量（厂商返回的 usage 解析归一化）。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** 一次 LLM 调用的结果。 */
export interface LlmResult {
  content: string;
  /** 思考模型思维链原文；仅用于非空判定与调试，不进事件流正文。 */
  reasoning?: string;
  raw?: unknown;
  finishReason?: string | null;
  toolCalls?: ChatToolCall[];
  /** 厂商返回的 token 用量；缺失（部分 provider 不返回）时为 undefined。 */
  usage?: TokenUsage;
}

/** 流式增量 chunk。 */
export interface LlmStreamChunk {
  content: string;
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
 * 基金层提供 OpenAiCompatibleClient 默认实现（OpenAI/Anthropic/openai_resp）。
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
}
