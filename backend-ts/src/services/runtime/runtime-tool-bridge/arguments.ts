import type { BashExecutionInput } from "../../tools/local-bash-tool-service.js";
import type { ToolExecutionResult } from "../../tools/memory-tool-service.js";
import type { RuntimeToolCall, RuntimeToolExecutionContext } from "../runtime-tool-types.js";
import type { RuntimeToolApprovalDecision } from "../permission-policy-service.js";
import { READ_ONLY_MEMORY_TOOL_NAMES, type ReadOnlyMemoryToolName } from "./registry.js";

export function buildToolCallContext(
  call: RuntimeToolCall,
  context: RuntimeToolExecutionContext,
): RuntimeToolExecutionContext {
  const callId = context.toolCallId ?? call.callId ?? null;
  if (callId === context.toolCallId) {
    return context;
  }
  return {
    ...context,
    toolCallId: callId,
  };
}

export function readTaskCreateArguments(value: Record<string, unknown> | undefined): {
  subject: string;
  description: string;
  activeForm?: string | null;
  metadata?: Record<string, unknown> | null;
} {
  return {
    subject: asString(value?.subject) ?? "",
    description: asString(value?.description) ?? "",
    activeForm: asString(value?.active_form) ?? asString(value?.activeForm),
    metadata: asRecord(value?.metadata),
  };
}

export function readTaskGetArguments(value: Record<string, unknown> | undefined): { taskId: string } {
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
  };
}

export function readTaskUpdateArguments(value: Record<string, unknown> | undefined): {
  taskId: string;
  subject?: string | null;
  description?: string | null;
  activeForm?: string | null;
  owner?: string | null;
  status?: string | null;
  addBlocks?: string[] | null;
  addBlockedBy?: string[] | null;
  metadata?: Record<string, unknown> | null;
} {
  const subject = asProvidedString(value, "subject");
  const description = asProvidedString(value, "description");
  const activeForm = asProvidedString(value, "active_form", "activeForm");
  const owner = asProvidedString(value, "owner");
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
    status: asString(value?.status),
    addBlocks: asStringArray(value?.add_blocks) ?? asStringArray(value?.addBlocks),
    addBlockedBy: asStringArray(value?.add_blocked_by) ?? asStringArray(value?.addBlockedBy),
    metadata: asRecord(value?.metadata),
    ...(subject !== undefined ? { subject } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(activeForm !== undefined ? { activeForm } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
}

export function readTaskOutputArguments(value: Record<string, unknown> | undefined): {
  taskId: string;
  block?: boolean | null;
  timeout?: number | null;
  maxChars?: number | null;
} {
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
    block: typeof value?.block === "boolean" ? value.block : null,
    timeout: asInteger(value?.timeout),
    maxChars: asInteger(value?.max_chars) ?? asInteger(value?.maxChars),
  };
}

export function readTaskStopArguments(value: Record<string, unknown> | undefined): { taskId: string } {
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
  };
}

export function readListMemoryIndexArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return {
    scope: asString(value?.scope) ?? "",
    sessionId: asString(value?.session_id) ?? asString(value?.sessionId),
    agentName: asString(value?.agent_name) ?? asString(value?.agentName),
    workspaceKey: asString(value?.workspace_key) ?? asString(value?.workspaceKey),
    currentAgentName: asString(value?.current_agent_name) ?? asString(value?.currentAgentName),
    teamName: asString(value?.team_name) ?? asString(value?.teamName),
    workspaceRoot: asString(value?.workspace_root) ?? asString(value?.workspaceRoot),
  };
}

export function readMemoryEntryArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  fileName: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return {
    ...readListMemoryIndexArguments(value),
    fileName: asString(value?.file_name) ?? asString(value?.fileName) ?? "",
  };
}

export function readWriteMemoryArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  name: string;
  description: string;
  memoryType: string;
  content: string;
  why?: string | null;
  howToApply?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return {
    ...readListMemoryIndexArguments(value),
    name: asString(value?.name) ?? "",
    description: asString(value?.description) ?? "",
    memoryType: asString(value?.memory_type) ?? asString(value?.memoryType) ?? "",
    content: typeof value?.content === "string" ? value.content : "",
    why: asString(value?.why),
    howToApply: asString(value?.how_to_apply) ?? asString(value?.howToApply),
    sourceRunId: asString(value?.source_run_id) ?? asString(value?.sourceRunId),
    sourceMessageId: asString(value?.source_message_id) ?? asString(value?.sourceMessageId),
  };
}

export function readArchiveMemoryArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  fileName: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return readMemoryEntryArguments(value);
}

export function readFileArguments(value: Record<string, unknown> | undefined): {
  filePath: string;
  encoding?: string | null;
  offset?: number | null;
  limit?: number | null;
  filePathSpace?: string | null;
} {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    encoding: asString(value?.encoding),
    offset: asInteger(value?.offset),
    limit: asInteger(value?.limit),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

export function writeFileArguments(value: Record<string, unknown> | undefined): {
  content: unknown;
  filePath?: string | null;
  encoding?: string | null;
  mode?: string | null;
  filePathSpace?: string | null;
} {
  return {
    content: value?.content ?? "",
    filePath: asString(value?.file_path) ?? asString(value?.filePath),
    encoding: asString(value?.encoding),
    mode: asString(value?.mode),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

export function editFileArguments(value: Record<string, unknown> | undefined): {
  filePath: string;
  oldString: string;
  newString: string;
  encoding?: string | null;
  replaceAll?: boolean | null;
  filePathSpace?: string | null;
} {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    oldString: asString(value?.old_string) ?? asString(value?.oldString) ?? "",
    newString: typeof value?.new_string === "string"
      ? value.new_string
      : typeof value?.newString === "string"
        ? value.newString
        : "",
    encoding: asString(value?.encoding),
    replaceAll: typeof value?.replace_all === "boolean"
      ? value.replace_all
      : typeof value?.replaceAll === "boolean"
        ? value.replaceAll
        : null,
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

export function previewDataStructureArguments(value: Record<string, unknown> | undefined): {
  filePath: string;
  encoding?: string | null;
  maxPreviewRows?: number | null;
  maxDepth?: number | null;
  maxFields?: number | null;
  filePathSpace?: string | null;
} {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    encoding: asString(value?.encoding),
    maxPreviewRows: asInteger(value?.max_preview_rows) ?? asInteger(value?.maxPreviewRows),
    maxDepth: asInteger(value?.max_depth) ?? asInteger(value?.maxDepth),
    maxFields: asInteger(value?.max_fields) ?? asInteger(value?.maxFields),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

export function readGlobArguments(value: Record<string, unknown> | undefined): {
  pattern: string;
  path?: string | null;
  recursive?: boolean | null;
  maxResults?: number | null;
} {
  return {
    pattern: asString(value?.pattern) ?? "",
    path: asString(value?.path),
    recursive: typeof value?.recursive === "boolean" ? value.recursive : null,
    maxResults: asInteger(value?.max_results) ?? asInteger(value?.maxResults),
  };
}

export function readGrepArguments(value: Record<string, unknown> | undefined): {
  pattern: string;
  path?: string | null;
  glob?: string | null;
  caseSensitive?: boolean | null;
  maxResults?: number | null;
  contextLines?: number | null;
} {
  return {
    pattern: asString(value?.pattern) ?? "",
    path: asString(value?.path),
    glob: asString(value?.glob),
    caseSensitive: typeof value?.case_sensitive === "boolean"
      ? value.case_sensitive
      : typeof value?.caseSensitive === "boolean"
        ? value.caseSensitive
        : null,
    maxResults: asInteger(value?.max_results) ?? asInteger(value?.maxResults),
    contextLines: asInteger(value?.context_lines) ?? asInteger(value?.contextLines),
  };
}

export function readWebFetchArguments(value: Record<string, unknown> | undefined): {
  url: string;
  timeoutMs?: number | null;
  maxChars?: number | null;
} {
  return {
    url: asString(value?.url) ?? "",
    timeoutMs: asInteger(value?.timeout_ms) ?? asInteger(value?.timeoutMs),
    maxChars: asInteger(value?.max_chars) ?? asInteger(value?.maxChars),
  };
}

export function readTodoWriteArguments(value: Record<string, unknown> | undefined): { todos: unknown } {
  return {
    todos: value?.todos ?? [],
  };
}

export function readBashArguments(value: Record<string, unknown> | undefined): BashExecutionInput {
  return {
    command: asString(value?.command) ?? "",
    workingDir: asString(value?.working_dir) ?? asString(value?.workingDir),
    workingDirSpace: asString(value?.working_dir_space) ?? asString(value?.workingDirSpace),
    timeout: asInteger(value?.timeout),
    runInBackground: typeof value?.run_in_background === "boolean"
      ? value.run_in_background
      : typeof value?.runInBackground === "boolean"
        ? value.runInBackground
        : null,
    description: asString(value?.description),
  };
}

export function readCallAgentArguments(value: Record<string, unknown> | undefined, callId: string | undefined): {
  agentName: string;
  task: string;
  contextHint?: string | null;
  callId?: string | null;
} {
  return {
    agentName: asString(value?.agent_name) ?? asString(value?.agentName) ?? "",
    task: asString(value?.task) ?? "",
    contextHint: asString(value?.context_hint) ?? asString(value?.contextHint),
    callId: callId ?? null,
  };
}

export function readListChildAgentsArguments(value: Record<string, unknown> | undefined): {
  agentName?: string | null;
  limit?: number | null;
} {
  return {
    agentName: asString(value?.agent_name) ?? asString(value?.agentName),
    limit: asInteger(value?.limit),
  };
}

export function readSendMessageArguments(value: Record<string, unknown> | undefined, callId: string | undefined): {
  childAgentId: string;
  message: string;
  callId?: string | null;
} {
  return {
    childAgentId: asString(value?.child_agent_id) ?? asString(value?.childAgentId) ?? "",
    message: asString(value?.message) ?? "",
    callId: callId ?? null,
  };
}

export function errorResult(
  message: string,
  toolName: string,
  metadata: Record<string, unknown> = {},
): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
      ...metadata,
    },
    artifacts: [],
    llm_hint: null,
  };
}

export function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
    toolName: string;
  },
): ToolExecutionResult<T> {
  return {
    success: true,
    tool_name: input.toolName,
    summary: input.summary,
    answer: null,
    output_type: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llm_hint: null,
  };
}

export function readPrompt(value: Record<string, unknown> | undefined): string | null {
  return asString(value?.prompt) ?? asString(value?.question) ?? asString(value?.message);
}

export function readInputType(value: Record<string, unknown> | undefined): string {
  return asString(value?.input_type) === "select" ? "select" : "text";
}

export function readOptions(value: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(value?.options)) {
    return [];
  }
  return value.options.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function buildApprovalMetadata(
  decision: RuntimeToolApprovalDecision,
  note = "",
): Record<string, unknown> {
  return {
    reason: decision.reason,
    note,
    ...(decision.reasonCodes.length ? { reason_codes: decision.reasonCodes } : {}),
    ...(decision.secondaryReasons.length ? { secondary_reasons: decision.secondaryReasons } : {}),
    ...(decision.approvedExternalPaths.length ? { approved_external_paths: decision.approvedExternalPaths } : {}),
  };
}

export function withApprovalMetadata<T>(
  result: ToolExecutionResult<T>,
  decision: RuntimeToolApprovalDecision,
  note: string,
): ToolExecutionResult<T> {
  return {
    ...result,
    metadata: {
      ...result.metadata,
      approval: buildApprovalMetadata(decision, note),
      ...(note ? { approval_message: note } : {}),
    },
  };
}

export function isReadOnlyMemoryToolName(toolName: string): toolName is ReadOnlyMemoryToolName {
  return READ_ONLY_MEMORY_TOOL_NAMES.includes(toolName as ReadOnlyMemoryToolName);
}

export function withApprovedExternalPaths(
  context: RuntimeToolExecutionContext,
  approvedExternalPaths: string[] | undefined,
): RuntimeToolExecutionContext {
  const merged = dedupeStrings([...(context.approvedExternalPaths ?? []), ...(approvedExternalPaths ?? [])]);
  return merged.length ? { ...context, approvedExternalPaths: merged } : context;
}

export function approvalUnsupportedError(
  toolName: string,
  approvedExternalPaths: string[],
): ToolExecutionResult<string> {
  return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文不支持审批`, toolName, {
    approval: {
      reason: "路径越界访问需要审批",
      note: "",
      reason_codes: ["ask-path"],
      approved_external_paths: approvedExternalPaths,
    },
  });
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asProvidedString(value: Record<string, unknown> | undefined, ...keys: string[]): string | null | undefined {
  if (!value) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return typeof value[key] === "string" ? value[key] : null;
    }
  }
  return undefined;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
