import type { CodeExecutionToolService } from "../../tools/code-execution-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
} from "../runtime-tool-types.js";
import { errorResult, readCodeExecutionArguments } from "../runtime-tool-bridge/arguments.js";
import { EXECUTE_CODE_TOOL, EXECUTE_CODE_TOOL_NAME } from "../runtime-tool-bridge/registry.js";

export class CodeExecutionToolProvider implements RuntimeToolProvider {
  readonly id = "code_execution";

  constructor(private readonly codeExecutionTools: CodeExecutionToolService | null) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    const enabledTools = new Set(input.agent?.tools.enabled_tools ?? []);
    return this.codeExecutionTools && enabledTools.has(EXECUTE_CODE_TOOL_NAME) ? [{ ...EXECUTE_CODE_TOOL }] : [];
  }

  canHandle(toolName: string): boolean {
    return toolName === EXECUTE_CODE_TOOL_NAME;
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    if (!this.codeExecutionTools) {
      return errorResult(`工具未暴露或暂未迁移: ${EXECUTE_CODE_TOOL_NAME}`, EXECUTE_CODE_TOOL_NAME);
    }
    return this.codeExecutionTools.executeCode(readCodeExecutionArguments(call.arguments), context);
  }
}
