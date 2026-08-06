/** token 估算:CJK 1 token、其余 1/4 字符;图片按 base64/4 粗估(vision token 近似)。 */
import type { ChatMessage, ContentPart, LlmRequest } from "@ragsystem/agent-llm";

const MESSAGE_FRAMING_TOKENS = 4;
const RESPONSE_PRIMING_TOKENS = 3;
const TOOL_SCHEMA_FRAMING_TOKENS = 8;

type TokenCountableMessage = {
  content: ChatMessage["content"];
  role?: ChatMessage["role"] | undefined;
  name?: ChatMessage["name"] | undefined;
  tool_call_id?: ChatMessage["tool_call_id"] | undefined;
  tool_calls?: ChatMessage["tool_calls"] | undefined;
  reasoning_blocks?: ChatMessage["reasoning_blocks"] | undefined;
};

export interface EstimatedRequestTokenUsage {
  systemPromptTokens: number;
  historyTokens: number;
  totalTokens: number;
}

export function estimateTokens(content: string | ContentPart[]): number {
  if (typeof content === "string") {
    if (!content) {
      return 0;
    }
    const cjkChars = content.match(/[㐀-鿿]/g)?.length ?? 0;
    const nonCjk = content.length - cjkChars;
    return Math.max(1, cjkChars + Math.ceil(nonCjk / 4));
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  // ContentPart[]:文本 part 按字符粗估,图片 part 按 base64/4 粗估(图片 token 近似,不绑厂商)。
  return content.reduce((sum, part) => {
    if (part.type === "text") {
      return sum + estimateTokens(part.text ?? "");
    }
    if (part.type === "image_url" && part.image_url?.url) {
      const url = part.image_url.url;
      const commaIdx = url.indexOf(",");
      const base64 = commaIdx >= 0 ? url.slice(commaIdx + 1) : url;
      return sum + Math.max(1, Math.ceil(base64.length / 4));
    }
    return sum;
  }, 0);
}

/** Estimate one fully structured chat message, including framing and tool-call payloads. */
export function estimateMessageTokens(message: TokenCountableMessage): number {
  let tokens = MESSAGE_FRAMING_TOKENS + estimateTokens(message.content);
  if (message.name) tokens += 1 + estimateTokens(message.name);
  if (message.tool_call_id) tokens += estimateTokens(message.tool_call_id);
  if (message.tool_calls?.length) tokens += estimateTokens(JSON.stringify(message.tool_calls));
  if (message.reasoning_blocks?.length) tokens += estimateTokens(JSON.stringify(message.reasoning_blocks));
  return tokens;
}

/**
 * 累加结构化消息 token。除 content（含图片）外，也覆盖消息封装、工具调用参数、
 * tool_call_id 与需要回传给 provider 的 reasoning blocks。
 */
export function countMessagesTokens(messages: ReadonlyArray<TokenCountableMessage>): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** Estimate the final provider request, including native tool schemas and response priming. */
export function estimateRequestTokenUsage(
  request: Pick<LlmRequest, "messages" | "tools">,
): EstimatedRequestTokenUsage {
  let systemPromptTokens = RESPONSE_PRIMING_TOKENS;
  let historyTokens = 0;
  for (const message of request.messages) {
    const tokens = estimateMessageTokens(message);
    if (message.role === "system") systemPromptTokens += tokens;
    else historyTokens += tokens;
  }
  if (request.tools?.length) {
    systemPromptTokens += TOOL_SCHEMA_FRAMING_TOKENS + estimateTokens(JSON.stringify(request.tools));
  }
  return {
    systemPromptTokens,
    historyTokens,
    totalTokens: systemPromptTokens + historyTokens,
  };
}
