import type { TaskToolService } from "../../tools/task-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
} from "../runtime-tool-types.js";
import {
  errorResult,
  readTaskCreateArguments,
  readTaskGetArguments,
  readTaskOutputArguments,
  readTaskStopArguments,
  readTaskUpdateArguments,
} from "../runtime-tool-bridge/arguments.js";
import {
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_OUTPUT_TOOL,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_WORKFLOW_TOOLS,
} from "../runtime-tool-bridge/registry.js";

export class TaskToolProvider implements RuntimeToolProvider {
  readonly id = "task";

  constructor(private readonly taskTools: TaskToolService | null) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    if (!this.taskTools) {
      return [];
    }
    const enabledTools = new Set(input.agent?.tools.enabled_tools ?? []);
    const tools: RuntimeToolDefinition[] = [];
    if (input.agent?.tasks?.workflow) {
      tools.push(...TASK_WORKFLOW_TOOLS.map((tool) => ({ ...tool })));
    }
    if (input.agent?.tasks?.background || enabledTools.has(TASK_OUTPUT_TOOL_NAME)) {
      tools.push({ ...TASK_OUTPUT_TOOL });
    }
    if (input.agent?.tasks?.background) {
      tools.push({ ...TASK_STOP_TOOL });
    }
    return tools;
  }

  canHandle(toolName: string): boolean {
    return (
      TASK_WORKFLOW_TOOLS.some((tool) => tool.name === toolName) ||
      toolName === TASK_OUTPUT_TOOL_NAME ||
      toolName === TASK_STOP_TOOL_NAME
    );
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    const taskTools = this.taskTools;
    const toolName = call.toolName.trim();
    if (!taskTools) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }
    switch (toolName) {
      case TASK_CREATE_TOOL_NAME:
        return taskTools.taskCreate(readTaskCreateArguments(call.arguments), context);
      case TASK_GET_TOOL_NAME:
        return taskTools.taskGet(readTaskGetArguments(call.arguments), context);
      case TASK_UPDATE_TOOL_NAME:
        return taskTools.taskUpdate(readTaskUpdateArguments(call.arguments), context);
      case TASK_LIST_TOOL_NAME:
        return taskTools.taskList(context);
      case TASK_OUTPUT_TOOL_NAME:
        return taskTools.taskOutput(readTaskOutputArguments(call.arguments));
      case TASK_STOP_TOOL_NAME:
        return taskTools.taskStop(readTaskStopArguments(call.arguments));
      default:
        return errorResult(`Task provider cannot handle tool: ${toolName}`, toolName || "unknown");
    }
  }
}
