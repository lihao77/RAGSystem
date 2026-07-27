/**
 * content 片段处理 helper（agent-llm 基金层，agent-sdk 复用）。
 *
 * ChatMessage.content 是 OpenAI 标准 string | ContentPart[]。本模块是全仓库唯一的 content
 * 处理来源：需要遍历/渲染的先 toContentParts，只需纯文本视图的（token 估算/压缩摘要）用 extractText。
 * 不在各处写 typeof content === "string" 判断。
 */
import type { ContentPart } from "./types.js";

/** content 统一成 ContentPart[]（string 包成单个 text part，空 string → 空数组）。 */
export function toContentParts(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content;
}

/**
 * 提取纯文本视图：只按顺序拼接真实 text part，不为 image part 合成占位文本。
 * 图片语义由结构化 image_url 和附件清单承载；string 输入原样返回。
 * 供 token 估算、压缩摘要、持久化与纯文本展示使用。
 */
export function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

/** 拆解 data URL（data:<mediaType>;base64,<data>）→ { mediaType, base64 }。非 data URL 返回 null。 */
export function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) {
    return null;
  }
  return { mediaType: match[1] ?? "image/png", base64: match[3] ?? "" };
}

/**
 * Responses API content（input_text / input_image）。
 * ContentPart[] → Responses input item 的 content part 数组形态。
 */
export function toResponsesContent(content: string | ContentPart[]): unknown[] {
  return toContentParts(content).map((part) => {
    if (part.type === "text") {
      return { type: "input_text", text: part.text };
    }
    const block: Record<string, unknown> = { type: "input_image", image_url: part.image_url.url };
    if (part.image_url.detail) {
      block.detail = part.image_url.detail;
    }
    return block;
  });
}

/**
 * Anthropic content blocks（text / image source）。
 * data URL → base64 source；http(s) URL → url source。空 content 回退单个空 text block（避免空数组）。
 */
export function toAnthropicContent(content: string | ContentPart[]): unknown[] {
  const blocks: unknown[] = [];
  for (const part of toContentParts(content)) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: parsed.mediaType, data: parsed.base64 },
        });
      } else {
        blocks.push({ type: "image", source: { type: "url", url: part.image_url.url } });
      }
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}
