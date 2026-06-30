/** token 估算（迁自 backend-ts context-compression estimateTokens）。CJK 1 token、其余 1/4 字符。 */
import type { ContentPart } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";

export function estimateTokens(content: string): number {
  if (!content) {
    return 0;
  }
  const cjkChars = content.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const nonCjk = content.length - cjkChars;
  return Math.max(1, cjkChars + Math.ceil(nonCjk / 4));
}

export function countMessagesTokens(messages: ReadonlyArray<{ content: string | ContentPart[] }>): number {
  return messages.reduce((total, message) => total + estimateTokens(extractText(message.content)), 0);
}
