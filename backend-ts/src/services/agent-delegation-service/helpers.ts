import type { AgentConfig } from "../../contracts/agent-config.js";
import type { ChildAgentInfo } from "../conversation-store.js";
import type { RuntimeToolExecutionContext } from "../runtime-tool-types.js";

export function buildDelegatedTask(task: string, contextHint: string | null | undefined): string {
  const hint = normalizeString(contextHint);
  if (!hint) {
    return task;
  }
  return `${task}\n\n[Context Hint]\n${hint}`;
}

export function buildChildMetadata(
  context: RuntimeToolExecutionContext,
  threadKey: string,
  createdVia: "call_agent",
): Record<string, unknown> {
  const workspaceRoot = normalizeString(context.workspaceRoot);
  return {
    created_via: createdVia,
    thread_key: threadKey,
    workspace_root: workspaceRoot,
    original_workspace_root: workspaceRoot,
    uses_worktree: false,
    worktree_disabled_reason: "worktree isolation is not migrated in the TypeScript runtime",
  };
}

export function getChildWorkspaceRoot(child: ChildAgentInfo, context: RuntimeToolExecutionContext): string | null {
  return normalizeString(child.metadata.workspace_root) ?? normalizeString(context.workspaceRoot);
}

export function buildRuntimeToolContext(
  agent: AgentConfig,
  input: {
    sessionId: string;
    runId: string;
    taskId: string | null;
    requestId: string | null;
    sessionMetadata: Record<string, unknown>;
    childAgent: ChildAgentInfo;
    workspaceRoot: string | null;
    parentCallId?: string | null | undefined;
    signal?: AbortSignal | undefined;
  },
): RuntimeToolExecutionContext {
  return {
    agent,
    sessionId: input.sessionId,
    runId: input.runId,
    taskId: input.taskId,
    requestId: input.requestId,
    currentAgentName: agent.agent_name,
    parentCallId: input.parentCallId ?? null,
    teamName: normalizeString(input.sessionMetadata.team),
    workspaceRoot: input.workspaceRoot ?? normalizeString(input.sessionMetadata.workspace_root),
    signal: input.signal,
  };
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

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
