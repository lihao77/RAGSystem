import { z } from "zod";

import type { TaskToolService } from "./TaskExecution.js";
import {
  readTaskCreateArguments,
  readTaskGetArguments,
  readTaskOutputArguments,
  readTaskStopArguments,
  readTaskUpdateArguments,
} from "../../services/runtime/runtime-tool-bridge/arguments.js";
import {
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
} from "../../services/runtime/runtime-tool-bridge/registry.js";
import type { RuntimeToolDefinition } from "../../services/runtime/runtime-tool-types.js";
import { buildTool, type RuntimeTool } from "../Tool.js";
import { metadataFrom, nullableStringArray, optionalBoolean, optionalInteger, optionalRecord, optionalString } from "../schema-helpers.js";

interface TaskToolDeps {
  taskTools: TaskToolService | null;
}

const taskCreateSchema = z.object({
  subject: z.string(),
  description: z.string(),
  active_form: optionalString,
  activeForm: optionalString,
  metadata: optionalRecord,
}).strict();

const taskGetSchema = z.object({
  task_id: z.string(),
  taskId: z.string().optional(),
}).strict();

const taskUpdateSchema = z.object({
  task_id: z.string(),
  taskId: z.string().optional(),
  subject: optionalString,
  description: optionalString,
  active_form: optionalString,
  activeForm: optionalString,
  owner: optionalString,
  status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional().nullable(),
  add_blocks: nullableStringArray(),
  addBlocks: nullableStringArray(),
  add_blocked_by: nullableStringArray(),
  addBlockedBy: nullableStringArray(),
  metadata: optionalRecord,
}).strict();

const taskListSchema = z.object({}).strict();
const taskOutputSchema = z.object({
  task_id: z.string(),
  taskId: z.string().optional(),
  block: optionalBoolean,
  timeout: optionalInteger,
  max_chars: optionalInteger,
  maxChars: optionalInteger,
}).strict();
const taskStopSchema = taskGetSchema;

const TASK_WORKFLOW_TOOLS: RuntimeToolDefinition[] = [
  {
    name: TASK_CREATE_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Create a session-scoped task record for multi-step work tracking.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "description"],
      properties: {
        subject: { type: "string", description: "Short task title." },
        description: { type: "string", description: "Detailed task description and acceptance criteria." },
        active_form: { type: "string", description: "Display text while the task is in progress." },
        metadata: { type: "object", description: "Optional metadata." },
      },
    },
  },
  {
    name: TASK_GET_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Read a session-scoped task by id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Task id returned by task_create." },
      },
    },
  },
  {
    name: TASK_UPDATE_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Update task fields, status, dependency links, or metadata.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: {
        task_id: { type: "string" },
        subject: { type: "string" },
        description: { type: "string" },
        active_form: { type: "string" },
        owner: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
        add_blocks: { type: "array", items: { type: "string" } },
        add_blocked_by: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
      },
    },
  },
  {
    name: TASK_LIST_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "List session-scoped task summaries.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

const TASK_OUTPUT_TOOL: RuntimeToolDefinition = {
  name: TASK_OUTPUT_TOOL_NAME,
  source: "runtime_builtin",
  category: "task",
  riskLevel: "low",
  allowed_callers: ["direct"],
  description: "Read a background task status and output, optionally requesting an explicit wait.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task_id"],
    properties: {
      task_id: { type: "string", description: "Background task id." },
      block: { type: "boolean", description: "Whether to request waiting for completion." },
      timeout: { type: "integer", minimum: 0, maximum: 600000, description: "Wait timeout in milliseconds." },
      max_chars: { type: "integer", minimum: 200, description: "Maximum output characters to read." },
    },
  },
};

const TASK_STOP_TOOL: RuntimeToolDefinition = {
  name: TASK_STOP_TOOL_NAME,
  source: "runtime_builtin",
  category: "task",
  riskLevel: "medium",
  allowed_callers: ["direct"],
  description: "Stop a cancellable background task.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task_id"],
    properties: {
      task_id: { type: "string", description: "Background task id." },
    },
  },
};

export function createTaskTools(deps: TaskToolDeps): RuntimeTool[] {
  const taskTools = deps.taskTools;
  if (!taskTools) {
    return [];
  }
  const workflowDefinitions = new Map(TASK_WORKFLOW_TOOLS.map((definition) => [definition.name, definition]));
  return [
    buildTool({
      ...metadataFrom(workflowDefinitions.get(TASK_CREATE_TOOL_NAME)!),
      inputSchema: taskCreateSchema,
      isVisible: (agent) => agent?.tasks.workflow === true,
      call: (input, context) => taskTools.taskCreate(readTaskCreateArguments(input), context),
    }),
    buildTool({
      ...metadataFrom(workflowDefinitions.get(TASK_GET_TOOL_NAME)!),
      inputSchema: taskGetSchema,
      isVisible: (agent) => agent?.tasks.workflow === true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input, context) => taskTools.taskGet(readTaskGetArguments(input), context),
    }),
    buildTool({
      ...metadataFrom(workflowDefinitions.get(TASK_UPDATE_TOOL_NAME)!),
      inputSchema: taskUpdateSchema,
      isVisible: (agent) => agent?.tasks.workflow === true,
      call: (input, context) => taskTools.taskUpdate(readTaskUpdateArguments(input), context),
    }),
    buildTool({
      ...metadataFrom(workflowDefinitions.get(TASK_LIST_TOOL_NAME)!),
      inputSchema: taskListSchema,
      isVisible: (agent) => agent?.tasks.workflow === true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (_input, context) => taskTools.taskList(context),
    }),
    buildTool({
      ...metadataFrom(TASK_OUTPUT_TOOL),
      inputSchema: taskOutputSchema,
      isVisible: (agent) => agent?.tasks.background === true || new Set(agent?.tools.enabled_tools ?? []).has(TASK_OUTPUT_TOOL_NAME),
      isReadOnly: () => true,
      isConcurrencySafe: () => false,
      call: (input) => taskTools.taskOutput(readTaskOutputArguments(input)),
    }),
    buildTool({
      ...metadataFrom(TASK_STOP_TOOL),
      inputSchema: taskStopSchema,
      isVisible: (agent) => agent?.tasks.background === true,
      call: (input) => taskTools.taskStop(readTaskStopArguments(input)),
    }),
  ];
}

export { TASK_OUTPUT_TOOL_NAME, TASK_STOP_TOOL_NAME };
