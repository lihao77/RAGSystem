import type { AgentDelegationService } from "../../agent/agent-delegation-service.js";
import type { CodeExecutionToolService } from "../../tools/code-execution-tool-service.js";
import type { LocalDocumentToolService } from "../../tools/local-document-tool-service.js";
import type { LocalSearchToolService } from "../../tools/local-search-tool-service.js";
import type { SkillToolService } from "../../tools/skill-tool-service.js";
import type { ToolExecutionResult, MemoryToolService } from "../../tools/memory-tool-service.js";
import type { TaskToolService } from "../../tools/task-tool-service.js";
import type { VectorLibraryService, VectorSearchResult } from "../../knowledge/vector-library-service.js";
import type { McpService } from "../../integrations/mcp-service.js";
import type { RuntimeToolCall, RuntimeToolExecutionContext } from "../runtime-tool-types.js";
import {
  editFileArguments,
  errorResult,
  previewDataStructureArguments,
  readArchiveMemoryArguments,
  readCallAgentArguments,
  readCodeExecutionArguments,
  readFileArguments,
  readGlobArguments,
  readGrepArguments,
  readListChildAgentsArguments,
  readListMemoryIndexArguments,
  readMemoryEntryArguments,
  readSearchKnowledgeBaseArguments,
  readSendMessageArguments,
  readSkillToolArguments,
  readTaskCreateArguments,
  readTaskGetArguments,
  readTaskOutputArguments,
  readTaskStopArguments,
  readTaskUpdateArguments,
  readTodoWriteArguments,
  readWebFetchArguments,
  readWriteMemoryArguments,
  writeFileArguments,
} from "./arguments.js";
import {
  ARCHIVE_MEMORY_TOOL_NAME,
  CALL_AGENT_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  EXECUTE_CODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
  LIST_CHILD_AGENTS_TOOL_NAME,
  PREVIEW_DATA_STRUCTURE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  REQUEST_USER_INPUT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  EXECUTE_SKILL_SCRIPT_TOOL_NAME,
  GET_SKILL_INFO_TOOL_NAME,
  LOAD_SKILL_RESOURCE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
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
  codeExecutionTools: CodeExecutionToolService | null;
  skillTools: SkillToolService | null;
  searchTools: LocalSearchToolService | null;
  taskTools: TaskToolService | null;
  vectorLibrary: VectorLibraryService | null;
  mcp: McpService | null;
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
    [GLOB_TOOL_NAME, (call, context) => {
      const searchTools = deps.searchTools;
      return searchTools
        ? searchTools.glob(readGlobArguments(call.arguments), context)
        : deps.unavailableTool(GLOB_TOOL_NAME);
    }],
    [GREP_TOOL_NAME, (call, context) => {
      const searchTools = deps.searchTools;
      return searchTools
        ? searchTools.grep(readGrepArguments(call.arguments), context)
        : deps.unavailableTool(GREP_TOOL_NAME);
    }],
    [WEB_FETCH_TOOL_NAME, (call) => {
      const searchTools = deps.searchTools;
      return searchTools
        ? searchTools.webFetch(readWebFetchArguments(call.arguments))
        : deps.unavailableTool(WEB_FETCH_TOOL_NAME);
    }],
    [TODO_WRITE_TOOL_NAME, (call, context) => {
      const searchTools = deps.searchTools;
      return searchTools
        ? searchTools.todoWrite(readTodoWriteArguments(call.arguments), context)
        : deps.unavailableTool(TODO_WRITE_TOOL_NAME);
    }],
    [EXECUTE_CODE_TOOL_NAME, (call, context) => {
      const codeExecutionTools = deps.codeExecutionTools;
      return codeExecutionTools
        ? codeExecutionTools.executeCode(readCodeExecutionArguments(call.arguments), context)
        : deps.unavailableTool(EXECUTE_CODE_TOOL_NAME);
    }],
    [ACTIVATE_SKILL_TOOL_NAME, (call, context) => {
      const skillTools = deps.skillTools;
      return skillTools
        ? skillTools.activateSkill(readSkillToolArguments(call.arguments), context)
        : deps.unavailableTool(ACTIVATE_SKILL_TOOL_NAME);
    }],
    [LOAD_SKILL_RESOURCE_TOOL_NAME, (call, context) => {
      const skillTools = deps.skillTools;
      return skillTools
        ? skillTools.loadSkillResource(readSkillToolArguments(call.arguments), context)
        : deps.unavailableTool(LOAD_SKILL_RESOURCE_TOOL_NAME);
    }],
    [GET_SKILL_INFO_TOOL_NAME, (call, context) => {
      const skillTools = deps.skillTools;
      return skillTools
        ? skillTools.getSkillInfo(readSkillToolArguments(call.arguments), context)
        : deps.unavailableTool(GET_SKILL_INFO_TOOL_NAME);
    }],
    [EXECUTE_SKILL_SCRIPT_TOOL_NAME, (call, context) => {
      const skillTools = deps.skillTools;
      return skillTools
        ? skillTools.executeSkillScript(readSkillToolArguments(call.arguments), context)
        : deps.unavailableTool(EXECUTE_SKILL_SCRIPT_TOOL_NAME);
    }],
    [SEARCH_KNOWLEDGE_BASE_TOOL_NAME, (call, context) => {
      const vectorLibrary = deps.vectorLibrary;
      if (!vectorLibrary) {
        return deps.unavailableTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME);
      }
      const input = readSearchKnowledgeBaseArguments(call.arguments);
      const kbConfig = context.agent?.knowledge_base;
      const collection = input.collection ?? kbConfig?.default_collection ?? "documents";
      const searchMode = normalizeSearchMode(input.searchMode ?? kbConfig?.default_search_mode);
      const topK = input.topK ?? kbConfig?.default_top_k ?? 5;
      const rerank = input.rerank ?? kbConfig?.default_rerank ?? false;
      try {
        const search = vectorLibrary.search({
          query: input.query,
          collection,
          top_k: topK,
          search_mode: searchMode,
          rerank,
          filters: input.filters ?? undefined,
          reranker_key: kbConfig?.default_reranker_key ?? undefined,
        });
        const results = Array.isArray(search.results) ? search.results as VectorSearchResult[] : [];
        const content = formatSearchResults(results);
        return {
          success: true,
          tool_name: SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
          summary: `在 ${collection} 中搜索到 ${results.length} 条结果`,
          answer: null,
          output_type: "text",
          content,
          metadata: {
            count: results.length,
            collection,
            search_mode: searchMode,
          },
          artifacts: [],
          llm_hint: null,
        } satisfies ToolExecutionResult<string>;
      } catch (error) {
        return errorResult(
          `知识库搜索失败: ${error instanceof Error ? error.message : String(error)}`,
          SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
        );
      }
    }],
    [LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME, () => {
      const vectorLibrary = deps.vectorLibrary;
      if (!vectorLibrary) {
        return deps.unavailableTool(LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME);
      }
      try {
        const collections = vectorLibrary.listCollections();
        const content = collections.length
          ? collections.map((collection) => {
              const name = String(collection.name ?? "");
              const docCount = Number(collection.document_count ?? asRecord(collection.metadata)?.document_count ?? 0);
              const chunkCount = Number(collection.chunk_count ?? collection.total_chunks ?? 0);
              return `- ${name}: ${docCount} 文档, ${chunkCount} 分块`;
            }).join("\n")
          : "当前没有可用的知识库集合。";
        return {
          success: true,
          tool_name: LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
          summary: collections.length ? `共 ${collections.length} 个集合` : "无可用集合",
          answer: null,
          output_type: "text",
          content,
          metadata: { count: collections.length },
          artifacts: [],
          llm_hint: null,
        } satisfies ToolExecutionResult<string>;
      } catch (error) {
        return errorResult(
          `列出集合失败: ${error instanceof Error ? error.message : String(error)}`,
          LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
        );
      }
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

function normalizeSearchMode(value: string | null | undefined): "hybrid" | "vector" {
  return value?.trim().toLowerCase() === "vector" ? "vector" : "hybrid";
}

function formatSearchResults(results: VectorSearchResult[]): string {
  if (!results.length) {
    return "未找到相关结果。";
  }
  return results.map((item, index) => {
    const source = String(item.metadata.source_file ?? item.metadata.source ?? "").trim();
    const score = item.similarity || item.hybrid_score || item.rerank_score || 0;
    const header = `[${index + 1}]${source ? ` ${source}` : ""}${score ? ` (score: ${score.toFixed(4)})` : ""}`;
    return `${header}\n${item.content.trim()}`;
  }).join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
