/**
 * projectConversationExtensions——按 messagesToConversation 的 originals 索引，把消息扩展投影进模型消息。
 *
 * messagesToConversation 对 user 消息保持 1:1 数量对应(占位只补在 assistant tool_call 后),故按 user 序对齐可靠。
 * 注:user 的 content 可能已被 expanded_task 投影改写(messagesToConversation 内),但本函数消费 rawMessages
 * (原始 user.metadata.extensions)、追加投影进 conversation user content,不读 conversation 原始 content,故不受影响。
 * user 支持 ui_context，tool 支持 tool_result_media；各 projector 自行校验 role。
 * 投影文本/parts 追加到 content 末尾。
 *
 * 必须在 messagesToConversation 之后调用(content 此时是初始 string);本函数接管所有 extensions 投影。
 */
import type { ChatMessage, ContentPart } from "@ragsystem/agent-llm";
import type { ProjectionRegistry } from "./registry.js";
import type { ProjectContext } from "./types.js";
import { normalizeExtensions } from "./normalize.js";

type RawMessage = { role: string; metadata: Record<string, unknown> } | null;

export async function projectConversationExtensions(
  conversation: ChatMessage[],
  rawMessages: ReadonlyArray<RawMessage>,
  registry: ProjectionRegistry,
  ctxBase: Omit<ProjectContext, "role">,
): Promise<void> {
  for (const [index, msg] of conversation.entries()) {
    const raw = rawMessages[index];
    if (!raw || raw.role !== msg.role) continue;
    if (raw.role === "tool" && isMicrocompactCleared(raw, msg)) continue;
    const exts = normalizeExtensions(raw.metadata);
    if (!exts || exts.length === 0) continue;
    const ctx: ProjectContext = { ...ctxBase, role: raw.role };
    for (const ext of exts) {
      const projected = await registry.project(ext, ctx);
      if (projected === null || projected === "") continue;
      appendProjection(msg, projected);
    }
  }
}

function isMicrocompactCleared(raw: NonNullable<RawMessage>, message: ChatMessage): boolean {
  if (raw.metadata.microcompact_cleared === true) return true;
  return typeof message.content === "string" && message.content.startsWith("[工具结果已清理");
}

function appendProjection(msg: ChatMessage, projected: ContentPart[] | string): void {
  if (typeof projected === "string") {
    if (typeof msg.content === "string") {
      msg.content = `${msg.content}\n${projected}`;
    } else {
      msg.content = [...msg.content, { type: "text", text: projected }];
    }
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
