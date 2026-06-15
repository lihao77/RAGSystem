import type { LocalSearchToolService } from "../../tools/local-search-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
} from "../runtime-tool-types.js";
import {
  errorResult,
  readGlobArguments,
  readGrepArguments,
  readTodoWriteArguments,
  readWebFetchArguments,
} from "../runtime-tool-bridge/arguments.js";
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LOCAL_SEARCH_TOOLS,
  TODO_WRITE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
} from "../runtime-tool-bridge/registry.js";

export class LocalSearchToolProvider implements RuntimeToolProvider {
  readonly id = "local_search";

  constructor(private readonly searchTools: LocalSearchToolService | null) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    if (!this.searchTools) {
      return [];
    }
    const enabledTools = new Set(input.agent?.tools.enabled_tools ?? []);
    return LOCAL_SEARCH_TOOLS.filter((tool) => enabledTools.has(tool.name)).map((tool) => ({ ...tool }));
  }

  canHandle(toolName: string): boolean {
    return LOCAL_SEARCH_TOOLS.some((tool) => tool.name === toolName);
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    const searchTools = this.searchTools;
    const toolName = call.toolName.trim();
    if (!searchTools) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }
    switch (toolName) {
      case GLOB_TOOL_NAME:
        return searchTools.glob(readGlobArguments(call.arguments), context);
      case GREP_TOOL_NAME:
        return searchTools.grep(readGrepArguments(call.arguments), context);
      case WEB_FETCH_TOOL_NAME:
        return searchTools.webFetch(readWebFetchArguments(call.arguments));
      case TODO_WRITE_TOOL_NAME:
        return searchTools.todoWrite(readTodoWriteArguments(call.arguments), context);
      default:
        return errorResult(`Local search provider cannot handle tool: ${toolName}`, toolName || "unknown");
    }
  }
}
