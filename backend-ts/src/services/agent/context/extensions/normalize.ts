/**
 * normalizeExtensions——读侧归一:取出 metadata.extensions[](投影/渲染入口共用)。
 *
 * 写入侧(launchers)已把所有内容扩展(image/ui_context)统一落 extensions[],
 * 本函数纯透传:extensions 存在且非空则原样返回,否则空数组(防御缺字段/非数组)。
 *
 * 注:command_result / command 是消息类型(metadata.msg_type),background_notification 走
 * metadata.source——都不进 extensions[],走 role+msg_type/source 渲染分派与消息级上下文,
 * 不是内容伴随。
 */
import type { MessageExtension } from "./kinds.js";

export function normalizeExtensions(metadata?: Record<string, unknown> | null): MessageExtension[] {
  const existing = metadata?.extensions;
  return Array.isArray(existing) && existing.length ? (existing as MessageExtension[]) : [];
}
