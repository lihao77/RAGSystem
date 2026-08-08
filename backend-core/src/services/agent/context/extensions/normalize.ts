/**
 * normalizeExtensions——读侧归一:取出 metadata.extensions[](投影/渲染入口共用)。
 *
 * 写入侧只把消息正文之外的上下文扩展(ui_context/tool_result_media)落 extensions[],
 * 本函数纯透传:extensions 存在且非空则原样返回,否则空数组(防御缺字段/非数组)。
 *
 * command_ref / command_result 属于 content_parts；background_notification 走
 * metadata.source。它们都不是内容伴随。
 */
import type { MessageExtension } from "./kinds.js";

export function normalizeExtensions(metadata?: Record<string, unknown> | null): MessageExtension[] {
  const existing = metadata?.extensions;
  return Array.isArray(existing) && existing.length ? (existing as MessageExtension[]) : [];
}
