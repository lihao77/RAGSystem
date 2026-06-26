/**
 * prompt 上下文类型（设计稿 §7）。
 * AgentPromptContext 由消费端算好后注入（tools/backgroundTasks 均为纯展示数据）；
 * SDK prompt-builder 只负责拼装 section。skill / delegation 的可用清单不再走这里——
 * 它们由对应工具（skill 工具、call_agent）以 enum + extended_usage 自描述，走统一的 tools 段。
 */
import type { RuntimeToolDefinition } from "./tool-types.js";

export interface AgentPromptContext {
  tools?: RuntimeToolDefinition[] | undefined;
  /** 是否启用后台任务（替代 agent.tasks.background 读取，决定 run_in_background 参数是否裁剪）。 */
  backgroundTasks?: boolean | undefined;
}

export function collectSections(parts: Array<string | null | undefined>): string[] {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean);
}

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
