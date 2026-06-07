import type { AgentDelegationService } from "../../agent/agent-delegation-service.js";
import type { LocalDocumentToolService } from "../../tools/local-document-tool-service.js";
import type { ToolExecutionResult, MemoryToolService } from "../../tools/memory-tool-service.js";
import type { TaskToolService } from "../../tools/task-tool-service.js";
import type { RuntimeToolCall, RuntimeToolExecutionContext } from "../runtime-tool-types.js";
import {
  editFileArguments,
  previewDataStructureArguments,
  readArchiveMemoryArguments,
  readCallAgentArguments,
  readFileArguments,
  readListChildAgentsArguments,
  readListMemoryIndexArguments,
  readMemoryEntryArguments,
  readSendMessageArguments,
  readTaskCreateArguments,
  readTaskGetArguments,
  readTaskOutputArguments,
  readTaskStopArguments,
  readTaskUpdateArguments,
  readWriteMemoryArguments,
  writeFileArguments,
} from "./arguments.js";
import {
  ARCHIVE_MEMORY_TOOL_NAME,
  CALL_AGENT_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  LIST_CHILD_AGENTS_TOOL_NAME,
  PREVIEW_DATA_STRUCTURE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  REQUEST_USER_INPUT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WRITE_MEMORY_TOOL_NAME,
} from "./registry.js";

export type RuntimeToolHandler = (
  call: RuntimeToolCall,
  context: RuntimeToolExecutionContext,
) => ToolExecutionResult | Promise<ToolExecutionResult>;

export interface RuntimeToolHandlerDependencies {
  memoryTools: MemoryToolService;
  documentTools: LocalDocumentToolService | null;
  taskTools: TaskToolService | null;
  getAgentDelegation: () => AgentDelegationService | null;
  requestUserInput: RuntimeToolHandler;
  unavailableTool: (toolName: string) => ToolExecutionResult<string>;
}

export function createRuntimeToolHandlers(deps: RuntimeToolHandlerDependencies): Map<string, RuntimeToolHandler> {
  return new Map<string, RuntimeToolHandler>([
    [REQUEST_USER_INPUT_TOOL_NAME, deps.requestUserInput],
    [READ_FILE_TOOL_NAME, (call, context) => {
      const documentTools = deps.documentTools;
      return documentTools
        ? documentTools.readFile(readFileArguments(call.arguments), context)
        : deps.unavailableTool(READ_FILE_TOOL_NAME);
    }],
    [WRITE_FILE_TOOL_NAME, (call, context) => {
      const documentTools = deps.documentTools;
      return documentTools
        ? documentTools.writeFile(writeFileArguments(call.arguments), context)
        : deps.unavailableTool(WRITE_FILE_TOOL_NAME);
    }],
    [EDIT_FILE_TOOL_NAME, (call, context) => {
      const documentTools = deps.documentTools;
      return documentTools
        ? documentTools.editFile(editFileArguments(call.arguments), context)
        : deps.unavailableTool(EDIT_FILE_TOOL_NAME);
    }],
    [PREVIEW_DATA_STRUCTURE_TOOL_NAME, (call, context) => {
      const documentTools = deps.documentTools;
      return documentTools
        ? documentTools.previewDataStructure(previewDataStructureArguments(call.arguments), context)
        : deps.unavailableTool(PREVIEW_DATA_STRUCTURE_TOOL_NAME);
    }],
    [TASK_CREATE_TOOL_NAME, (call, context) => {
      const taskTools = deps.taskTools;
      return taskTools
        ? taskTools.taskCreate(readTaskCreateArguments(call.arguments), context)
        : deps.unavailableTool(TASK_CREATE_TOOL_NAME);
    }],
    [TASK_GET_TOOL_NAME, (call, context) => {
      const taskTools = deps.taskTools;
      return taskTools
        ? taskTools.taskGet(readTaskGetArguments(call.arguments), context)
        : deps.unavailableTool(TASK_GET_TOOL_NAME);
    }],
    [TASK_UPDATE_TOOL_NAME, (call, context) => {
      const taskTools = deps.taskTools;
      return taskTools
        ? taskTools.taskUpdate(readTaskUpdateArguments(call.arguments), context)
        : deps.unavailableTool(TASK_UPDATE_TOOL_NAME);
    }],
    [TASK_LIST_TOOL_NAME, (_call, context) => {
      const taskTools = deps.taskTools;
      return taskTools ? taskTools.taskList(context) : deps.unavailableTool(TASK_LIST_TOOL_NAME);
    }],
    [TASK_OUTPUT_TOOL_NAME, (call) => {
      const taskTools = deps.taskTools;
      return taskTools
        ? taskTools.taskOutput(readTaskOutputArguments(call.arguments))
        : deps.unavailableTool(TASK_OUTPUT_TOOL_NAME);
    }],
    [TASK_STOP_TOOL_NAME, (call) => {
      const taskTools = deps.taskTools;
      return taskTools
        ? taskTools.taskStop(readTaskStopArguments(call.arguments))
        : deps.unavailableTool(TASK_STOP_TOOL_NAME);
    }],
    ["list_memory_index", (call, context) => deps.memoryTools.listMemoryIndex(readListMemoryIndexArguments(call.arguments), context)],
    ["read_memory_entry", (call, context) => deps.memoryTools.readMemoryEntry(readMemoryEntryArguments(call.arguments), context)],
    [WRITE_MEMORY_TOOL_NAME, (call, context) => deps.memoryTools.writeMemory(readWriteMemoryArguments(call.arguments), context)],
    [ARCHIVE_MEMORY_TOOL_NAME, (call, context) => deps.memoryTools.archiveMemory(readArchiveMemoryArguments(call.arguments), context)],
    [CALL_AGENT_TOOL_NAME, (call, context) => {
      const agentDelegation = deps.getAgentDelegation();
      return agentDelegation
        ? agentDelegation.callAgent(readCallAgentArguments(call.arguments, context.toolCallId ?? call.callId), context)
        : deps.unavailableTool(CALL_AGENT_TOOL_NAME);
    }],
    [LIST_CHILD_AGENTS_TOOL_NAME, (call, context) => {
      const agentDelegation = deps.getAgentDelegation();
      return agentDelegation
        ? agentDelegation.listChildAgents(readListChildAgentsArguments(call.arguments), context)
        : deps.unavailableTool(LIST_CHILD_AGENTS_TOOL_NAME);
    }],
    [SEND_MESSAGE_TOOL_NAME, (call, context) => {
      const agentDelegation = deps.getAgentDelegation();
      return agentDelegation
        ? agentDelegation.sendMessage(readSendMessageArguments(call.arguments, context.toolCallId ?? call.callId), context)
        : deps.unavailableTool(SEND_MESSAGE_TOOL_NAME);
    }],
  ]);
}
