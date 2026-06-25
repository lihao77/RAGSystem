/**
 * LLM 客户端适配器 —— 把 backend-ts LlmChatClient 适配成 SDK LlmClient 端口。
 *
 * 为什么需要：SDK 的 createRuntime + protocol 层产出 LlmRequest（无 agent 字段），但 backend-ts 的
 * LlmChatClient 消费 ChatCompletionRequest（含 agent）。生产用 OpenAiCompatibleChatClient，
 * 测试注入 FakeChatClient。本适配器保留这一注入点——避免 SDK 路径绕过测试 mock 直连真实 HTTP。
 *
 * 字段映射：LlmRequest → ChatCompletionRequest（补 agent + 同构字段直传）；
 * ChatCompletionResult/ChatStreamChunk → LlmResult/LlmStreamChunk（同构直传）。
 */
import type {
  ChatToolCall,
  LlmClient,
  LlmRequest,
  LlmResult,
  LlmStreamChunk,
  LlmStreamHandler,
} from "@ragsystem/agent-llm";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatStreamChunkHandler,
  LlmChatClient,
} from "../../integrations/llm-chat-client.js";

export interface LlmClientAdapterOptions {
  /** backend-ts LLM 客户端（OpenAiCompatibleChatClient 或测试 FakeChatClient）。 */
  chatClient: LlmChatClient;
  /** 当次 run 的 agent（ChatCompletionRequest.agent 必填，SDK LlmRequest 不携带）。 */
  agent: AgentConfig;
}

/**
 * 适配 LlmChatClient → LlmClient。per-run 构造（绑定 agent）。
 * SDK protocol 调 llm.stream(LlmRequest, onChunk) → 本适配器转 ChatCompletionRequest → chatClient.stream。
 */
export class LlmClientAdapter implements LlmClient {
  /** 流式入口（仅底层 chatClient 支持 stream 时存在；缺省 → SDK 协议走非流式）。 */
  stream?: (request: LlmRequest, onChunk: LlmStreamHandler) => Promise<LlmResult>;

  constructor(private readonly options: LlmClientAdapterOptions) {
    // 仅当底层 chatClient 真正支持流式时才暴露 stream——否则 SDK 协议走非流式路径
    //（invokeNonStreaming，不发 first_token/output_delta），对齐旧内核"非流式无逐字流"语义。
    if (typeof this.options.chatClient.stream === "function") {
      this.stream = this.streamOverChatClient.bind(this);
    }
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const result = await this.options.chatClient.complete(this.toChatRequest(request));
    return toLlmResult(result);
  }

  /** 流式实现（仅 chatClient 支持 stream 时由构造期赋给 this.stream）。 */
  private async streamOverChatClient(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    const result = await this.options.chatClient.stream!.call(
      this.options.chatClient,
      this.toChatRequest(request),
      this.wrapOnChunk(onChunk),
    );
    return toLlmResult(result);
  }

  /** LlmStreamHandler → ChatStreamChunkHandler（同构 chunk 转发）。 */
  private wrapOnChunk(onChunk: LlmStreamHandler): ChatStreamChunkHandler {
    return (chunk) => {
      const mapped: LlmStreamChunk = { content: chunk.content };
      if (chunk.finishReason !== undefined) {
        mapped.finishReason = chunk.finishReason;
      }
      if (chunk.raw !== undefined) {
        mapped.raw = chunk.raw;
      }
      if (chunk.toolCalls !== undefined) {
        mapped.toolCalls = chunk.toolCalls;
      }
      return onChunk(mapped);
    };
  }

  /** LlmRequest → ChatCompletionRequest（补 agent；provider 强转；同构字段直传）。 */
  private toChatRequest(request: LlmRequest): ChatCompletionRequest {
    const chatRequest: ChatCompletionRequest = {
      messages: request.messages,
      model: request.model,
      provider: request.provider as unknown as ModelProviderConfig,
      agent: this.options.agent,
    };
    if (request.signal) {
      chatRequest.signal = request.signal;
    }
    if (request.temperature !== undefined) {
      chatRequest.temperature = request.temperature;
    }
    if (request.maxCompletionTokens !== undefined) {
      chatRequest.maxCompletionTokens = request.maxCompletionTokens;
    }
    if (request.tools) {
      chatRequest.tools = request.tools;
    }
    if (request.toolChoice) {
      chatRequest.toolChoice = request.toolChoice;
    }
    if (request.allowEmptyStream) {
      chatRequest.allowEmptyStream = request.allowEmptyStream;
    }
    if (request.extraParams) {
      chatRequest.extraParams = request.extraParams;
    }
    return chatRequest;
  }
}

/** ChatCompletionResult → LlmResult（同构直传）。 */
function toLlmResult(result: ChatCompletionResult): LlmResult {
  const llmResult: LlmResult = { content: result.content };
  if (result.finishReason !== undefined) {
    llmResult.finishReason = result.finishReason;
  }
  if (result.raw !== undefined) {
    llmResult.raw = result.raw;
  }
  if (result.toolCalls) {
    llmResult.toolCalls = result.toolCalls as ChatToolCall[];
  }
  return llmResult;
}
