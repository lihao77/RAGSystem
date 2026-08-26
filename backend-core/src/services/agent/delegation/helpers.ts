import { normalizeString } from "../../../utils/guards.js";
export { normalizeString };
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { ChildAgentInfo } from "../../../contracts/conversation-store/index.js";
import type { ToolExecContext } from "@ragsystem/agent-sdk";

/**
 * 子 Agent 结果的默认输出契约：父 Agent 未在 Context Hint 指定输出格式时，
 * 子 Agent 最终回复按"结论/产物/风险"组织，让父 Agent 能可靠综合多路委派结果。
 */
const DELEGATION_RESULT_CONTRACT = [
  "[Result Contract]",
  "未另行指定输出格式时，最终回复按以下结构组织：",
  "1. 结论：直接结论或交付内容",
  "2. 产物：写入 workspace 的交付文件相对路径（无则省略）",
  "3. 风险：未完成项、关键假设与风险（无则省略）",
].join("\n");

export function buildDelegatedTask(task: string, contextHint: string | null | undefined): string {
  const hint = normalizeString(contextHint);
  const parts = [task];
  if (hint) {
    parts.push(`[Context Hint]\n${hint}`);
  }
  parts.push(DELEGATION_RESULT_CONTRACT);
  return parts.join("\n\n");
}

export function buildChildMetadata(
  context: ToolExecContext,
  createdVia: "agent",
): Record<string, unknown> {
  const workspaceRoot = normalizeString(context.workspaceRoot);
  return {
    created_via: createdVia,
    workspace_root: workspaceRoot,
  };
}

export function getChildWorkspaceRoot(child: ChildAgentInfo, context: ToolExecContext): string | null {
  return normalizeString(child.metadata.workspace_root) ?? normalizeString(context.workspaceRoot);
}

export function applyWorkspaceOverride(agent: AgentConfig, workspaceRoot: string | null): AgentConfig {
  if (!workspaceRoot) {
    return agent;
  }
  return {
    ...agent,
    custom_params: {
      ...agent.custom_params,
      workspace_root: workspaceRoot,
    },
  };
}

export function clampInteger(value: number | null, min: number, max: number): number {
  const integer = typeof value === "number" && Number.isInteger(value) ? value : min;
  return Math.min(max, Math.max(min, integer));
}
