import { z } from "zod";

import type { TaskToolService } from "./TaskExecution.js";
import {
  readGoalCreateArguments,
  readGoalGetArguments,
  readGoalUpdateArguments,
  readTaskOutputArguments,
  readTaskStopArguments,
} from "../../services/runtime/runtime-tool-bridge/arguments.js";
import {
  GOAL_CREATE_TOOL_NAME,
  GOAL_GET_TOOL_NAME,
  GOAL_LIST_TOOL_NAME,
  GOAL_UPDATE_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
} from "../../services/runtime/runtime-tool-bridge/registry.js";
import {
  buildTool,
  type Tool,
  type ToolExecContext,
  type RuntimeToolDefinition,
} from "@ragsystem/agent-sdk";
import { metadataFrom, optionalBoolean, optionalInteger, optionalRecord, optionalString } from "../schema-helpers.js";
import type { AgentConfig } from "../../contracts/agent/agent-config.js";
import { isGoalId } from "../../contracts/runtime/goals.js";

interface TaskToolDeps {
  taskTools: TaskToolService | null;
  agent: AgentConfig;
}

const goalIdSchema = z.string().refine(isGoalId, { message: "goal_id 必须是有效 UUID" });
const goalStepSchema = z.object({
  id: z.string(), title: z.string(), description: z.string().optional().default(""),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]).optional().default("pending"),
  evidence: optionalString,
}).strict();
const goalCreateSchema = z.object({
  objective: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1).optional(),
  successCriteria: z.array(z.string().min(1)).min(1).optional(),
  steps: z.array(goalStepSchema).optional(),
  checkpoint: optionalRecord,
  progress: optionalRecord,
}).strict().refine((value) => Boolean(value.success_criteria?.length || value.successCriteria?.length), {
  message: "success_criteria 至少需要一项",
});
const goalGetSchema = z.object({ goal_id: goalIdSchema.optional(), goalId: goalIdSchema.optional() }).strict();
const goalUpdateSchema = z.object({
  goal_id: goalIdSchema.optional(), goalId: goalIdSchema.optional(), objective: optionalString,
  success_criteria: z.array(z.string().min(1)).min(1).nullable().optional(), successCriteria: z.array(z.string().min(1)).min(1).nullable().optional(),
  steps: z.array(goalStepSchema).nullable().optional(), checkpoint: optionalRecord, progress: optionalRecord,
  status: z.enum(["active", "paused", "completed", "blocked"]).optional().nullable(),
}).strict();
const goalListSchema = z.object({}).strict();
const taskOutputSchema = z.object({
  task_id: z.string(),
  taskId: z.string().optional(),
  block: optionalBoolean,
  timeout: optionalInteger,
  max_chars: optionalInteger,
  maxChars: optionalInteger,
}).strict();
const taskStopSchema = z.object({
  task_id: z.string().min(1),
  taskId: z.string().min(1).optional(),
}).strict();

const GOAL_TOOLS: RuntimeToolDefinition[] = [
  {
    name: GOAL_CREATE_TOOL_NAME,
    source: "runtime_builtin",
    category: "goal",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Create the session's durable multi-run Goal. Include verifiable success criteria and staged steps; only one active/paused Goal may exist per session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["objective", "success_criteria"],
      properties: {
        objective: { type: "string", description: "The user's final objective." },
        success_criteria: { type: "array", items: { type: "string" }, description: "Verifiable completion criteria." },
        steps: {
          type: "array",
          description: "Current staged execution plan; update it dynamically as new work is discovered.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "description", "status"],
            properties: {
              id: { type: "string" }, title: { type: "string" }, description: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
              evidence: { type: "string" },
            },
          },
        },
        checkpoint: { type: "object" },
        progress: { type: "object" },
      },
    },
  },
  {
    name: GOAL_GET_TOOL_NAME,
    source: "runtime_builtin",
    category: "goal",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Read a Goal by id, or the current active/paused Goal when omitted.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal_id: { type: "string", format: "uuid" },
      },
    },
  },
  {
    name: GOAL_UPDATE_TOOL_NAME,
    source: "runtime_builtin",
    category: "goal",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Update the Goal after meaningful progress. Keep steps/checkpoint current; set completed only when success criteria have evidence, paused on user request, and blocked only when progress is impossible.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal_id: { type: "string", format: "uuid" }, objective: { type: "string" },
        success_criteria: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { type: "object" } }, checkpoint: { type: "object" }, progress: { type: "object" },
        status: { type: "string", enum: ["active", "paused", "completed", "blocked"] },
      },
    },
  },
  {
    name: GOAL_LIST_TOOL_NAME,
    source: "runtime_builtin",
    category: "goal",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "List current and historical Goals for this session.",
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

export function createTaskTools(deps: TaskToolDeps): Tool[] {
  const taskTools = deps.taskTools;
  const agent = deps.agent;
  if (!taskTools) {
    return [];
  }
  const goalDefinitions = new Map(GOAL_TOOLS.map((definition) => [definition.name, definition]));
  const enabledTools = new Set(agent.tools?.enabled_tools ?? []);
  const tools: Tool[] = [];

  if (agent.goals?.enabled === true) {
    tools.push(
      buildTool({
        ...metadataFrom(goalDefinitions.get(GOAL_CREATE_TOOL_NAME)!), inputSchema: goalCreateSchema,
        call: (input, ctx: ToolExecContext) => taskTools.goalCreate(readGoalCreateArguments(input), ctx),
      }),
      buildTool({
        ...metadataFrom(goalDefinitions.get(GOAL_GET_TOOL_NAME)!), inputSchema: goalGetSchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        call: (input, ctx: ToolExecContext) => taskTools.goalGet(readGoalGetArguments(input), ctx),
      }),
      buildTool({
        ...metadataFrom(goalDefinitions.get(GOAL_UPDATE_TOOL_NAME)!), inputSchema: goalUpdateSchema,
        call: (input, ctx: ToolExecContext) => taskTools.goalUpdate(readGoalUpdateArguments(input), ctx),
      }),
      buildTool({
        ...metadataFrom(goalDefinitions.get(GOAL_LIST_TOOL_NAME)!), inputSchema: goalListSchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        call: (_input, ctx: ToolExecContext) => taskTools.goalList(ctx),
      }),
    );
  }

  if (agent.tasks?.background === true || enabledTools.has(TASK_OUTPUT_TOOL_NAME)) {
    tools.push(
      buildTool({
        ...metadataFrom(TASK_OUTPUT_TOOL),
        inputSchema: taskOutputSchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => false,
        call: (input) => taskTools.taskOutput(readTaskOutputArguments(input)),
      }),
    );
  }

  if (agent.tasks?.background === true) {
    tools.push(
      buildTool({
        ...metadataFrom(TASK_STOP_TOOL),
        inputSchema: taskStopSchema,
        call: (input) => taskTools.taskStop(readTaskStopArguments(input)),
      }),
    );
  }

  return tools;
}

export { TASK_OUTPUT_TOOL_NAME, TASK_STOP_TOOL_NAME };
