/**
 * projectConversationExtensions——把 rawMessages 里 user 消息的 extensions 投影进 conversation。
 *
 * messagesToConversation 对 user 消息保持 1:1 数量对应(占位只补在 assistant tool_call 后),故按 user 序对齐可靠。
 * 注:user 的 content 可能已被 expanded_task 投影改写(messagesToConversation 内),但本函数消费 rawMessages
 * (原始 user.metadata.extensions)、追加投影进 conversation user content,不读 conversation 原始 content,故不受影响。
 * 本期只处理 user(extensions 主要挂在 user:ui_context/image_attachment);其余 kind projector 返回 null
 * 不投影。投影文本/parts 追加到 content 末尾。
 *
 * 必须在 messagesToConversation 之后调用(content 此时是初始 string);本函数接管所有 extensions 投影。
 */
import type { ChatMessage, ContentPart } from "@ragsystem/agent-llm";
import type { ProjectionRegistry } from "./registry.js";
import type { ProjectContext } from "./types.js";
import type { MessageExtension } from "./kinds.js";
import { normalizeExtensions } from "./normalize.js";

type RawMessage = { role: string; metadata: Record<string, unknown> };

export function projectConversationExtensions(
  conversation: ChatMessage[],
  rawMessages: ReadonlyArray<RawMessage>,
  registry: ProjectionRegistry,
  ctxBase: Omit<ProjectContext, "role">,
): void {
  const userExtQueue: MessageExtension[][] = [];
  for (const m of rawMessages) {
    if (m.role !== "user") continue;
    userExtQueue.push(normalizeExtensions(m.metadata));
  }
  const ctx: ProjectContext = { ...ctxBase, role: "user" };
  for (const msg of conversation) {
    if (msg.role !== "user") continue;
    const exts = userExtQueue.shift();
    if (!exts || exts.length === 0) continue;
    for (const ext of exts) {
      const projected = registry.project(ext, ctx);
      if (projected === null || projected === "") continue;
      appendProjection(msg, projected);
    }
  }
}

function appendProjection(msg: ChatMessage, projected: ContentPart[] | string): void {
  if (typeof projected === "string") {
    if (typeof msg.content === "string") {
      msg.content = `${msg.content}\n${projected}`;
    }
    // content 已是 ContentPart[] 时,纯字符串投影降级忽略(本期无此场景)
    return;
  }
  if (projected.length === 0) return;
  msg.content = mergeParts(msg.content, projected);
}

function mergeParts(existing: ChatMessage["content"], extra: ContentPart[]): ContentPart[] {
  if (typeof existing === "string") {
    const parts: ContentPart[] = [];
    if (existing) parts.push({ type: "text", text: existing });
    return [...parts, ...extra];
  }
  return [...existing, ...extra];
}
