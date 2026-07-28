import type { McpService } from "../mcp-service.js";
import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";

interface McpToolDeps {
  mcp: McpService;
  enabledServers: string[];
}

export function createMcpTools(deps: McpToolDeps): Tool[] {
  const enabledServers = deps.enabledServers;
  const serverTools = deps.mcp.listRuntimeTools(enabledServers).map((definition) =>
    buildTool({
      name: definition.name,
      description: definition.description,
      inputJSONSchema: definition.parameters,
      parameters: definition.parameters,
      source: "mcp",
      category: "mcp",
      riskLevel: definition.riskLevel,
      allowedCallers: ["direct"],
      ...(definition.usage_contract ? { usageContract: definition.usage_contract } : {}),
      ...(definition.returns ? { returns: definition.returns } : {}),
      // annotations 是 server 自声明 hint:readOnlyHint+idempotentHint 才允许并发,否则保守串行。
      isReadOnly: () => definition.annotations?.readOnlyHint === true,
      isConcurrencySafe: () =>
        definition.annotations?.readOnlyHint === true && definition.annotations?.idempotentHint !== false,
      call: (input, ctx: ToolExecContext) =>
        deps.mcp!.callRuntimeTool(definition.name, input, ctx.sessionId ? { session_id: ctx.sessionId } : undefined),
    }),
  );
  if (!enabledServers.length) {
    return serverTools;
  }
  // 元工具:让 agent 能按需读取已连接 MCP server 暴露的只读资源(MCP resources 能力面)。
  return [...serverTools, buildReadMcpResourceTool(deps.mcp, enabledServers)];
}

function buildReadMcpResourceTool(mcp: McpService, enabledServers: string[]): Tool {
  return buildTool({
    name: "read_mcp_resource",
    description:
      "读取已连接 MCP server 暴露的只读资源(MCP resources 能力面,如文件/数据快照)。server_name 须为当前启用的 MCP server,uri 为该 server 暴露的资源 URI。",
    source: "mcp",
    category: "mcp",
    riskLevel: "low",
    allowedCallers: ["direct"],
    inputJSONSchema: {
      type: "object",
      additionalProperties: false,
      required: ["server_name", "uri"],
      properties: {
        server_name: { type: "string", enum: enabledServers, description: "MCP server name(当前启用)" },
        uri: { type: "string", description: "Resource URI(server 暴露的资源标识)" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async (input, _ctx: ToolExecContext) => {
      const serverName = typeof input?.server_name === "string" ? input.server_name : "";
      const uri = typeof input?.uri === "string" ? input.uri : "";
      if (!serverName || !uri) {
        return toolError("read_mcp_resource", "server_name 和 uri 必填");
      }
      try {
        const contents = await mcp.readResource(serverName, uri);
        return toolSuccess(contents, {
          toolName: "read_mcp_resource",
          summary: `读取 MCP 资源 ${serverName}:${uri}`,
          outputType: "json",
          metadata: { server_name: serverName, uri },
        });
      } catch (error) {
        return toolError("read_mcp_resource", `读取失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}
