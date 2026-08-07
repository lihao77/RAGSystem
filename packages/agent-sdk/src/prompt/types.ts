/**
 * prompt 上下文类型（设计稿 §7）。
 * AgentPromptContext 由消费端算好后注入（tools 为纯展示数据，executionPaths 为稳定执行环境路径）；
 * SDK prompt-builder 只负责拼装 section。skill / delegation 的候选清单不再由内核单独组装，
 * 而是由对应工具写入参数 schema；system prompt 只补充 schema 外的通用约束。
 */
import type { RuntimeToolDefinition } from "./tool-types.js";
import type { ToolExecutionPaths } from "../contracts.js";

export interface AgentPromptContext {
  tools?: RuntimeToolDefinition[] | undefined;
  /** Stable paths for the current execution environment, supplied by the host. */
  executionPaths?: ToolExecutionPaths | undefined;
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
