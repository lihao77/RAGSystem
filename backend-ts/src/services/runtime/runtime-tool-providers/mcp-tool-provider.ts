import type { McpService } from "../../integrations/mcp-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
} from "../runtime-tool-types.js";
import { errorResult } from "../runtime-tool-bridge/arguments.js";

export class McpToolProvider implements RuntimeToolProvider {
  readonly id = "mcp";

  constructor(private readonly mcp: McpService | null) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    return this.mcp && input.agent?.mcp.enabled_servers.length
      ? this.mcp.listRuntimeTools(input.agent.mcp.enabled_servers)
      : [];
  }

  canHandle(toolName: string): boolean {
    return toolName.startsWith("mcp__");
  }

  executeTool(call: RuntimeToolCall, _context: RuntimeToolExecutionContext) {
    const toolName = call.toolName.trim();
    return this.mcp
      ? this.mcp.callRuntimeTool(toolName, call.arguments)
      : errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
  }
}
