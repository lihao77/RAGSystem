/**
 * prompt 上下文类型（设计稿 §7）。
 * AgentPromptContext 由消费端算好后注入（tools/skills/delegatedAgents/backgroundTasks 均为纯展示数据）；
 * SDK prompt-builder 只负责拼装 section，不算 context（skills/delegatedAgents 的算取依赖消费端容器）。
 */
import type { RuntimeToolDefinition } from "./tool-types.js";

export interface AgentPromptSkill {
  name: string;
  description?: string | null | undefined;
}

export interface AgentPromptDelegatedAgent {
  agent_name: string;
  display_name?: string | null | undefined;
  description?: string | null | undefined;
  use_cases?: unknown;
  tool_count?: number | null | undefined;
}

export interface AgentPromptContext {
  tools?: RuntimeToolDefinition[] | undefined;
  skills?: AgentPromptSkill[] | undefined;
  delegatedAgents?: AgentPromptDelegatedAgent[] | undefined;
  /** 是否启用后台任务（替代 agent.tasks.background 读取，决定 run_in_background 参数是否裁剪 + 后台执行段是否产出）。 */
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
