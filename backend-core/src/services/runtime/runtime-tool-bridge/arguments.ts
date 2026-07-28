import { asString, asRecord } from "../../../utils/guards.js";
import type { BashExecutionInput } from "../../../tools/BashTool/BashExecution.js";
import { readCodeExecutionArguments } from "../../../tools/CodeExecutionTool/CodeExecution.js";
import type { GoalStep } from "../../../contracts/runtime/goals.js";

export function readGoalCreateArguments(value: Record<string, unknown> | undefined): {
  objective: string;
  successCriteria: string[];
  steps: GoalStep[];
  checkpoint?: Record<string, unknown> | null;
  progress?: Record<string, unknown> | null;
} {
  return {
    objective: asString(value?.objective) ?? "",
    successCriteria: asStringArray(value?.success_criteria) ?? asStringArray(value?.successCriteria) ?? [],
    steps: readGoalSteps(value?.steps),
    checkpoint: asRecord(value?.checkpoint),
    progress: asRecord(value?.progress),
  };
}

export function readGoalGetArguments(value: Record<string, unknown> | undefined): { goalId?: string | null } {
  return { goalId: asString(value?.goal_id) ?? asString(value?.goalId) };
}

export function readGoalUpdateArguments(value: Record<string, unknown> | undefined): {
  goalId?: string | null;
  objective?: string | null;
  successCriteria?: string[] | null;
  steps?: GoalStep[] | null;
  checkpoint?: Record<string, unknown> | null;
  progress?: Record<string, unknown> | null;
  status?: string | null;
} {
  const objective = asProvidedString(value, "objective");
  return {
    goalId: asString(value?.goal_id) ?? asString(value?.goalId),
    successCriteria: asStringArray(value?.success_criteria) ?? asStringArray(value?.successCriteria),
    steps: Object.prototype.hasOwnProperty.call(value ?? {}, "steps") ? readGoalSteps(value?.steps) : null,
    checkpoint: asRecord(value?.checkpoint),
    progress: asRecord(value?.progress),
    status: asString(value?.status),
    ...(objective !== undefined ? { objective } : {}),
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

export { readCodeExecutionArguments };


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
): import("@ragsystem/agent-sdk").ToolExecutionResult {
  return {
    success: false,
    toolName,
    summary: message,
    answer: null,
    outputType: "error",
    content: message,
    metadata: { source_shape: "error", ...metadata },
    artifacts: [],
    llmHint: null,
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
): import("@ragsystem/agent-sdk").ToolExecutionResult {
  return {
    success: true,
    toolName: input.toolName,
    summary: input.summary,
    answer: null,
    outputType: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llmHint: null,
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

function readGoalSteps(value: unknown): GoalStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const step = entry as Record<string, unknown>;
    const status = asString(step.status) ?? "pending";
    if (!["pending", "in_progress", "completed", "blocked"].includes(status)) return [];
    return [{
      id: asString(step.id) ?? String(index + 1),
      title: asString(step.title) ?? "",
      description: asString(step.description) ?? "",
      status: status as GoalStep["status"],
      evidence: asString(step.evidence),
    }];
  });
}
