import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ExecutionObservability, ExecutionTaskStatus } from "../../../contracts/execution.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import { isRuntimeStableSystemContextContent } from "../agent-runtime-context-builder.js";
import { buildFullSystemPrompt, type AgentPromptContext } from "../agent-prompt-builder.js";
import type { BackgroundTaskNotificationPayload } from "../../runtime/background-task-service.js";
import type { CheckpointInfo } from "../../stores/checkpoint-manager.js";
import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import type { RuntimeToolExecutionContext } from "../../runtime/runtime-tool-types.js";

export function buildObservability(status: ExecutionTaskStatus): ExecutionObservability {
  return {
    task_id: status.task_id,
    session_id: status.session_id,
    run_id: status.run_id,
    execution_kind: status.execution_kind,
    request_id: status.request_id,
  };
}

export function summarizeReadinessFailure(
  requirements: Array<{ category: string; satisfied: boolean; message: string }>,
): string {
  const failures = requirements.filter((item) => item.category !== "execution_runtime" && !item.satisfied);
  return failures.length ? failures.map((item) => item.message).join("; ") : "Runtime core configuration is not ready";
}

export function mirrorEventData<T extends Record<string, unknown>>(data: T): { data: T; content: T } {
  return {
    data,
    content: data,
  };
}

export function cloneStatus(status: ExecutionTaskStatus | null): ExecutionTaskStatus | null {
  return status ? { ...status } : null;
}

export function findLatestCheckpointUserTask(checkpoint: CheckpointInfo): string | null {
  for (let index = checkpoint.messages.length - 1; index >= 0; index -= 1) {
    const message = checkpoint.messages[index];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }
  }
  return null;
}

export function checkpointMessagesToConversation(messages: Array<Record<string, unknown>>): ChatMessage[] {
  const conversation: ChatMessage[] = [];
  for (const message of messages) {
    const role = message.role;
    const content = message.content;
    if (typeof content !== "string" || !content.trim()) {
      continue;
    }
    if (role === "system" || role === "user" || role === "assistant") {
      conversation.push({ role, content });
    }
  }
  return conversation;
}

export function renderBackgroundNotification(payload: BackgroundTaskNotificationPayload): string {
  const taskId = asString(payload.background_task_id) ?? asString(payload.task_id) ?? "unknown";
  const status = asString(payload.status) ?? "completed";
  const outputPath = asString(payload.output_path) ?? asString(payload.background_output_path);
  const returnCode = payload.return_code;
  const resultType = asString(payload.result_type);
  const summary = asString(payload.summary) ?? asString(payload.description) ?? backgroundTaskSummary(taskId, status);
  const parts = ["<task-notification>", `<task-id>${escapeXmlText(taskId)}</task-id>`];
  if (outputPath) {
    parts.push(`<output-file>${escapeXmlText(outputPath)}</output-file>`);
  }
  parts.push(`<status>${escapeXmlText(status)}</status>`);
  if (returnCode !== null && returnCode !== undefined) {
    parts.push(`<return-code>${escapeXmlText(String(returnCode))}</return-code>`);
  }
  if (resultType) {
    parts.push(`<result-type>${escapeXmlText(resultType)}</result-type>`);
  }
  if (summary) {
    parts.push(`<summary>${escapeXmlText(summary)}</summary>`);
  }
  parts.push("</task-notification>");
  return parts.join("\n");
}

function backgroundTaskSummary(taskId: string, status: string): string {
  if (status === "running") {
    return `后台任务 ${taskId} 仍在运行`;
  }
  if (status === "failed") {
    return `后台任务 ${taskId} 执行失败，输出已写入文件`;
  }
  if (status === "cancelled") {
    return `后台任务 ${taskId} 已取消，输出已写入文件`;
  }
  return `后台任务 ${taskId} 已完成，输出已写入文件`;
}

export function normalizeSessionEntryAgent(value: unknown): string | null {
  const normalized = asString(value);
  if (!normalized) {
    return null;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === "default") {
    return null;
  }
  if (lowered === "orchestrator") {
    return "orchestrator_agent";
  }
  return normalized;
}

export function applySessionAgentOverrides(agent: AgentConfig, sessionMetadata: Record<string, unknown>): AgentConfig {
  const workspaceRoot = asString(sessionMetadata.workspace_root);
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

export function buildRuntimeToolContext(
  agent: AgentConfig,
  input: {
    sessionId: string;
    runId: string;
    taskId: string;
    requestId: string;
    sessionMetadata: Record<string, unknown>;
    parentCallId?: string | null | undefined;
    signal: AbortSignal;
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
    teamName: asString(input.sessionMetadata.team),
    workspaceRoot: asString(input.sessionMetadata.workspace_root) ?? asString(agent.custom_params.workspace_root),
    signal: input.signal,
  };
}

export function buildRunStartPayload(input: {
  runId: string;
  taskId: string;
  requestId: string;
  agent: AgentConfig;
  executionKind?: string | undefined;
  recoveredFrom?: string | undefined;
}): Record<string, unknown> {
  return {
    task_id: input.taskId,
    agent_name: input.agent.agent_name,
    run_id: input.runId,
    request_id: input.requestId,
    ...(input.executionKind !== undefined ? { execution_kind: input.executionKind } : {}),
    ...(input.recoveredFrom !== undefined ? { recovered_from: input.recoveredFrom } : {}),
  };
}

export function buildRunStartStepPayload(input: {
  rootCallId: string;
  runId: string;
  taskId: string;
  requestId: string;
  agent: AgentConfig;
  description: string;
  executionKind?: string | undefined;
  recoveredFrom?: string | undefined;
  checkpointId?: string | undefined;
  checkpointRound?: number | undefined;
}): Record<string, unknown> {
  return {
    kind: "run",
    phase: "start",
    call_id: input.rootCallId,
    parent_call_id: null,
    step_id: `${input.rootCallId}:run`,
    parent_step_id: null,
    agent_name: input.agent.agent_name,
    agent_display_name: input.agent.display_name || input.agent.agent_name,
    description: input.description,
    status: "running",
    task_id: input.taskId,
    run_id: input.runId,
    request_id: input.requestId,
    ...(input.executionKind !== undefined ? { execution_kind: input.executionKind } : {}),
    ...(input.recoveredFrom !== undefined ? { recovered_from: input.recoveredFrom } : {}),
    ...(input.checkpointId !== undefined ? { checkpoint_id: input.checkpointId } : {}),
    ...(input.checkpointRound !== undefined ? { checkpoint_round: input.checkpointRound } : {}),
  };
}

export function buildRunEndStepPayload(input: {
  rootCallId: string;
  runId: string;
  taskId: string;
  requestId: string;
  agent: AgentConfig;
  status: string;
  resultPreview?: string | undefined;
  error?: string | undefined;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: "run",
    phase: "end",
    call_id: input.rootCallId,
    parent_call_id: null,
    step_id: `${input.rootCallId}:run`,
    parent_step_id: null,
    agent_name: input.agent.agent_name,
    agent_display_name: input.agent.display_name || input.agent.agent_name,
    run_id: input.runId,
    task_id: input.taskId,
    request_id: input.requestId,
    status: input.status,
  };
  if (input.resultPreview) {
    payload.result_preview = input.resultPreview;
  }
  if (input.error) {
    payload.error = input.error;
  }
  return payload;
}

export function buildContextUsagePayload(input: {
  agent: AgentConfig;
  promptContext: AgentPromptContext;
  budgetTokens: number;
  messages: ChatMessage[];
  round: number;
  runId: string;
  taskId: string;
  requestId: string;
  compressionResult?: {
    status: string;
    reason: string;
    replacedMessageCount: number;
    replacesUpToSeq: number | null;
  } | null;
}): Record<string, unknown> {
  const rawSystemPromptTokens = estimateTokens(buildFullSystemPrompt(input.agent, input.promptContext));
  const systemContextTokens = input.messages
    .filter((message) => message.role === "system" && isRuntimeStableSystemContextContent(message.content))
    .reduce((total, message) => total + estimateTokens(message.content), 0);
  const historyTokens = input.messages
    .filter((message) => message.role !== "system" || !isRuntimeStableSystemContextContent(message.content))
    .reduce((total, message) => total + estimateTokens(message.content), 0);
  const systemPromptTokens = rawSystemPromptTokens + systemContextTokens;
  const totalTokens = systemPromptTokens + historyTokens;
  return {
    used_tokens: totalTokens,
    system_prompt_tokens: systemPromptTokens,
    total_tokens: totalTokens,
    budget_tokens: input.budgetTokens,
    round: input.round,
    compressing: false,
    agent_name: input.agent.agent_name,
    run_id: input.runId,
    task_id: input.taskId,
    request_id: input.requestId,
    ...(input.compressionResult
      ? {
          compression: {
            status: input.compressionResult.status,
            reason: input.compressionResult.reason,
            replaced_message_count: input.compressionResult.replacedMessageCount,
            replaces_up_to_seq: input.compressionResult.replacesUpToSeq,
          },
        }
      : {}),
  };
}

export function resolveLegacyContextBudget(agent: AgentConfig, provider: ModelProviderConfig): number {
  return positiveInt(provider.max_context_tokens)
    ?? positiveInt(agent.llm_tiers?.default?.max_context_tokens)
    ?? 128000;
}

function estimateTokens(content: string): number {
  if (!content) {
    return 0;
  }
  const cjkChars = content.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const nonCjk = content.length - cjkChars;
  return Math.max(1, cjkChars + Math.ceil(nonCjk / 4));
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
