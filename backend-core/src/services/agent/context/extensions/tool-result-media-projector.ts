import type { ContentPart } from "@ragsystem/agent-llm";
import type { ExtensionProjector } from "./types.js";

interface StoredToolImage {
  /** 旧通道（transient 临时文件）的落点；新记录同时携带 file_id 时仅作回退。 */
  stored_path: string;
  mime: string;
  kind: string;
  /** 会话附件通道的稳定引用（新形态）；后续轮次经附件管线读取（含变体归一化与缓存）。 */
  file_id?: string;
  original_name?: string;
}

/** Restores persisted tool image references without storing base64 in SQLite. */
export const toolResultMediaProjector: ExtensionProjector = {
  kind: "tool_result_media",
  async project(extension, ctx) {
    if (ctx.role !== "tool") return null;
    const media = extractToolImages(extension.data.media);
    const parts: ContentPart[] = [];
    for (const item of media) {
      if (!ctx.supportsVision) {
        parts.push({ type: "text", text: `[工具图片:${item.original_name ?? item.stored_path}(当前模型不支持图片识别)]` });
        continue;
      }
      const dataUrl = await readStoredToolImage(item, ctx);
      parts.push(dataUrl
        ? { type: "image_url", image_url: { url: dataUrl, detail: "auto" } }
        : { type: "text", text: `[工具图片已过期或加载失败:${item.original_name ?? item.stored_path}]` });
    }
    return parts.length ? parts : null;
  },
};

/**
 * 双读：file_id 优先（会话附件通道——持久、随会话清理、读取经请求变体归一化与
 * per-request 缓存）；无 file_id 或附件读取失败（含旧记录、已删除附件）回退
 * stored_path 的同步磁盘读（旧 transient 通道，TTL 过期后自然降级为文字提示）。
 */
async function readStoredToolImage(
  item: StoredToolImage,
  ctx: { sessionId: string; readAttachment: import("./types.js").AttachmentReader; readToolImage: import("./types.js").ToolImageReader },
): Promise<string | null> {
  if (item.file_id) {
    try {
      const source = await ctx.readAttachment(ctx.sessionId, item.file_id);
      if (source && source.body.length > 0) {
        const mime = normalizeImageMime(source.contentType) ?? normalizeImageMime(item.mime) ?? "image/png";
        return `data:${mime};base64,${Buffer.from(source.body).toString("base64")}`;
      }
    } catch {
      // 附件通道失败不阻断：落回旧通道再试一次。
    }
  }
  return ctx.readToolImage(item.stored_path, item.mime);
}

function normalizeImageMime(value: string | null | undefined): string | null {
  const mime = value?.trim();
  return mime && /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : null;
}

function extractToolImages(value: unknown): StoredToolImage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StoredToolImage => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as Record<string, unknown>;
    return record.kind === "image"
      && typeof record.stored_path === "string"
      && typeof record.mime === "string";
  });
}
