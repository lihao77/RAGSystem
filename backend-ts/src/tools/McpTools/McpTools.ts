import type { AgentConfig } from "../../contracts/agent-config.js";
import type { McpService } from "../../services/integrations/mcp-service.js";
import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";

interface McpToolDeps {
  mcp: McpService | null;
  agent: AgentConfig | null;
}

export function createMcpTools(deps: McpToolDeps): Tool[] {
  if (!deps.mcp) {
    return [];
  }
  const enabledServers = deps.agent?.mcp.enabled_servers ?? [];
  return deps.mcp.listRuntimeTools(enabledServers).map((definition) =>
    buildTool({
      name: definition.name,
      description: definition.description,
      inputJSONSchema: definition.parameters,
      parameters: definition.parameters,
      source: "mcp",
      category: "mcp",
      riskLevel: definition.riskLevel,
      allowedCallers: ["direct"],
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      call: (input, _ctx: ToolExecContext) => deps.mcp!.callRuntimeTool(definition.name, input),
    }),
  );
}
