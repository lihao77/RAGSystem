import { normalizeString } from "../../../utils/guards.js";
export { normalizeString };
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { ChildAgentInfo } from "../../../contracts/conversation-store/index.js";
import type { ToolExecContext } from "@ragsystem/agent-sdk";

export function buildDelegatedTask(task: string, contextHint: string | null | undefined): string {
  const hint = normalizeString(contextHint);
  if (!hint) {
    return task;
  }
  return `${task}\n\n[Context Hint]\n${hint}`;
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
