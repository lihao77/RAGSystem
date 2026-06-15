import type { LocalDocumentToolService } from "../../tools/local-document-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
} from "../runtime-tool-types.js";
import {
  editFileArguments,
  readFileArguments,
  writeFileArguments,
  previewDataStructureArguments,
  errorResult,
} from "../runtime-tool-bridge/arguments.js";
import {
  DOCUMENT_TOOLS,
  EDIT_FILE_TOOL_NAME,
  PREVIEW_DATA_STRUCTURE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from "../runtime-tool-bridge/registry.js";

export class DocumentToolProvider implements RuntimeToolProvider {
  readonly id = "document";

  constructor(private readonly documentTools: LocalDocumentToolService | null) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    if (!this.documentTools) {
      return [];
    }
    const enabledTools = new Set(input.agent?.tools.enabled_tools ?? []);
    return DOCUMENT_TOOLS.filter((tool) => enabledTools.has(tool.name)).map((tool) => ({ ...tool }));
  }

  canHandle(toolName: string): boolean {
    return DOCUMENT_TOOLS.some((tool) => tool.name === toolName);
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    const documentTools = this.documentTools;
    const toolName = call.toolName.trim();
    if (!documentTools) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }
    switch (toolName) {
      case READ_FILE_TOOL_NAME:
        return documentTools.readFile(readFileArguments(call.arguments), context);
      case WRITE_FILE_TOOL_NAME:
        return documentTools.writeFile(writeFileArguments(call.arguments), context);
      case EDIT_FILE_TOOL_NAME:
        return documentTools.editFile(editFileArguments(call.arguments), context);
      case PREVIEW_DATA_STRUCTURE_TOOL_NAME:
        return documentTools.previewDataStructure(previewDataStructureArguments(call.arguments), context);
      default:
        return errorResult(`Document provider cannot handle tool: ${toolName}`, toolName || "unknown");
    }
  }

  getExternalPathApprovalCandidates(
    toolName: string,
    args: Record<string, unknown> | undefined,
    context: RuntimeToolExecutionContext,
  ): string[] {
    return this.documentTools?.getExternalPathApprovalCandidates(toolName, args, context) ?? [];
  }
}
