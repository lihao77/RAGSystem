/** token 估算:CJK 1 token、其余 1/4 字符;图片按分辨率估(Anthropic 口径 w*h/750,厂商量级 1-2k/张)。 */
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
  /** 工具 schema 总 token（含 framing；systemPromptTokens 已含此项，构成占比展示用）。 */
  toolSchemaTokens: number;
  /** source=mcp 的工具 schema token（不含 framing，近似）。 */
  mcpToolTokens: number;
  /** source=knowledge 的工具 schema token（技能工具，不含 framing，近似）。 */
  knowledgeToolTokens: number;
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
  // ContentPart[]:文本 part 按字符粗估;图片 part 按分辨率估(业界各家均为千级 token/张,
  // base64/4 会把 900KB 截图估成 30 万 token,高估两个数量级,污染压缩判定的外推通道)。
  return content.reduce((sum, part) => {
    if (part.type === "text") {
      return sum + estimateTokens(part.text ?? "");
    }
    if (part.type === "image_url" && part.image_url?.url) {
      return sum + estimateImageTokens(part.image_url.url, part.image_url.detail);
    }
    return sum;
  }, 0);
}

/* ── 图片 token 估算:分辨率制(Anthropic w*h/750 口径,OpenAI tile/Gemini 块制同量级) ── */

/** Anthropic 口径:长边超此值先等比缩放(1568×1568 上限)。 */
const IMAGE_LONG_EDGE_CAP = 1568;
/** OpenAI low-detail 固定价,作所有图片的下限。 */
const IMAGE_MIN_TOKENS = 85;
/** 防御性上限:长边缩放后理论最大 floor(1568×1568/750)=3278,正常路径不可达,仅兜异常宽高。 */
const IMAGE_MAX_TOKENS = 4096;
/** 尺寸解析失败时的 fallback:1080p 截图三家口径的典型值(1.1k-1.6k)。 */
const IMAGE_FALLBACK_TOKENS = 1600;
/** detail:low 的缩放目标(OpenAI low=512×512 再计价,DeepSeek low 同为 512)。 */
const IMAGE_LOW_DETAIL_EDGE = 512;

const imageTokenCache = new Map<string, number>();

function estimateImageTokens(url: string, detail?: string): number {
  // data-URL 可能上百 KB;同一 URL 在 run 生命周期内每轮都会被重算,按 前缀+长度+后缀 缓存避免重复解析。
  const cacheKey = `${url.length}:${detail ?? ""}:${url.slice(0, 96)}:${url.slice(-32)}`;
  const cached = imageTokenCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const tokens = clampImageTokens(computeImageTokens(url, detail));
  if (imageTokenCache.size > 2048) imageTokenCache.clear();
  imageTokenCache.set(cacheKey, tokens);
  return tokens;
}

function computeImageTokens(url: string, detail?: string): number {
  const commaIdx = url.indexOf(",");
  const base64 = commaIdx >= 0 ? url.slice(commaIdx + 1) : url;
  const dims = readImageDimensions(base64);
  if (!dims) return IMAGE_FALLBACK_TOKENS;
  const edgeCap = detail === "low" ? IMAGE_LOW_DETAIL_EDGE : IMAGE_LONG_EDGE_CAP;
  const scale = Math.max(dims.width, dims.height) > edgeCap ? edgeCap / Math.max(dims.width, dims.height) : 1;
  const width = Math.max(1, Math.round(dims.width * scale));
  const height = Math.max(1, Math.round(dims.height * scale));
  return Math.floor((width * height) / 750);
}

function clampImageTokens(tokens: number): number {
  return Math.min(IMAGE_MAX_TOKENS, Math.max(IMAGE_MIN_TOKENS, tokens));
}

/** 头部最大解码量:PNG/GIF/WebP 头在前 64 字节;JPEG 的 SOF 可能躲在 EXIF 后,留 64KB 扫描窗口。 */
const DIMENSION_SCAN_BYTES = 64 * 1024;

function readImageDimensions(base64: string): { width: number; height: number } | null {
  // base64 按 4 字符一组解码,取前 N 字节只需前 ceil(N/3)*4 个字符,不全量解码。
  const chars = Math.min(base64.length, Math.ceil(DIMENSION_SCAN_BYTES / 3) * 4);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64.slice(0, chars), "base64");
  } catch {
    return null;
  }
  if (bytes.length < 24) return null;
  return readPngDimensions(bytes) ?? readGifDimensions(bytes) ?? readWebpDimensions(bytes) ?? readJpegDimensions(bytes);
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readGifDimensions(bytes: Buffer): { width: number; height: number } | null {
  const signature = bytes.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    // canvas 尺寸为 24bit 存值+1
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    // 14bit width-1 / 14bit height-1 跨字节小端打包
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    // lossy keyframe:3 字节 frame tag 后 0x9d012a 同步码,宽高各 14bit 小端
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // SOF0-15(排除 C4=DHT、C8=JPG、CC=DAC):帧头内含尺寸
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) return null;
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
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
  let toolSchemaTokens = 0;
  let mcpToolTokens = 0;
  let knowledgeToolTokens = 0;
  if (request.tools?.length) {
    toolSchemaTokens = TOOL_SCHEMA_FRAMING_TOKENS + estimateTokens(JSON.stringify(request.tools));
    systemPromptTokens += toolSchemaTokens;
    // 构成占比细分：per-tool 估算并按来源归类（仅用于展示，不参与预算计算，故不含 framing）。
    for (const tool of request.tools) {
      const tokens = estimateTokens(JSON.stringify(tool));
      if (tool.source === "mcp") mcpToolTokens += tokens;
      else if (tool.source === "knowledge") knowledgeToolTokens += tokens;
    }
  }
  return {
    systemPromptTokens,
    historyTokens,
    totalTokens: systemPromptTokens + historyTokens,
    toolSchemaTokens,
    mcpToolTokens,
    knowledgeToolTokens,
  };
}
