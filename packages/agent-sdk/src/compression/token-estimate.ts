/** token 估算:CJK 1 token、其余 1/4 字符;图片按 base64/4 粗估(vision token 近似)。 */
import type { ContentPart } from "@ragsystem/agent-llm";

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

/**
 * 累加消息 token。直接 estimateTokens(content)(支持 ContentPart[],含图片 token),
 * 不用 extractText(会丢图片)——压缩预算判断要含附件消耗。
 */
export function countMessagesTokens(messages: ReadonlyArray<{ content: string | ContentPart[] }>): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}
