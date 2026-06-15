import type { MemoryToolService, ToolExecutionResult } from "../../tools/memory-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
} from "../runtime-tool-types.js";
import {
  readArchiveMemoryArguments,
  readListMemoryIndexArguments,
  readMemoryEntryArguments,
  readWriteMemoryArguments,
} from "../runtime-tool-bridge/arguments.js";
import {
  ARCHIVE_MEMORY_TOOL,
  ARCHIVE_MEMORY_TOOL_NAME,
  READ_ONLY_MEMORY_TOOL_NAMES,
  READ_ONLY_MEMORY_TOOLS,
  WRITE_MEMORY_TOOL,
  WRITE_MEMORY_TOOL_NAME,
} from "../runtime-tool-bridge/registry.js";

export class MemoryToolProvider implements RuntimeToolProvider {
  readonly id = "memory";

  constructor(private readonly memoryTools: MemoryToolService) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    const tools: RuntimeToolDefinition[] = [];
    const memoryConfig = input.agent?.memory;
    if (memoryConfig?.allowed_scopes?.length) {
      tools.push(...READ_ONLY_MEMORY_TOOLS.map((tool) => ({ ...tool })));
    }
    if (memoryConfig?.write_scopes?.length) {
      tools.push({ ...WRITE_MEMORY_TOOL });
    }
    if (memoryConfig?.archive_scopes?.length) {
      tools.push({ ...ARCHIVE_MEMORY_TOOL });
    }
    return tools;
  }

  canHandle(toolName: string): boolean {
    return (
      READ_ONLY_MEMORY_TOOL_NAMES.includes(toolName as (typeof READ_ONLY_MEMORY_TOOL_NAMES)[number]) ||
      toolName === WRITE_MEMORY_TOOL_NAME ||
      toolName === ARCHIVE_MEMORY_TOOL_NAME
    );
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult> {
    const toolName = call.toolName.trim();
    switch (toolName) {
      case "list_memory_index":
        return this.memoryTools.listMemoryIndex(readListMemoryIndexArguments(call.arguments), context);
      case "read_memory_entry":
        return this.memoryTools.readMemoryEntry(readMemoryEntryArguments(call.arguments), context);
      case WRITE_MEMORY_TOOL_NAME:
        return this.memoryTools.writeMemory(readWriteMemoryArguments(call.arguments), context);
      case ARCHIVE_MEMORY_TOOL_NAME:
        return this.memoryTools.archiveMemory(readArchiveMemoryArguments(call.arguments), context);
      default:
        return {
          success: false,
          tool_name: toolName || "unknown",
          summary: `Memory provider cannot handle tool: ${toolName}`,
          answer: null,
          output_type: "error",
          content: `Memory provider cannot handle tool: ${toolName}`,
          metadata: { source_shape: "error" },
          artifacts: [],
          llm_hint: null,
        };
    }
  }
}
