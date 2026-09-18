import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { provideAgentCapability } from "@ragsystem/backend-core/plugins/agent-capability-provider.js";

import { MCP_RUNTIME_CAPABILITY } from "./capability.js";
import type { McpPluginDependencies } from "./dependencies.js";
import { registerMcpAgentConfigRoutes, registerMcpRoutes } from "./routes.js";
import { createMcpTools } from "./tools/McpTools.js";

export const MCP_PLUGIN_ID = "@ragsystem/backend-plugin-mcp";

export function createMcpPlugin(dependencies: McpPluginDependencies): BackendPlugin {
  return {
    manifest: { id: MCP_PLUGIN_ID, version: "0.2.1" },
    register(context) {
      context.runtimes.register(async (runtimeContext) => {
        const runtime = await dependencies.runtimeFactory(runtimeContext);
        return {
          capabilities: [
            provideCapability(MCP_RUNTIME_CAPABILITY, runtime),
            provideAgentCapability({
              id: "mcp",
              display_name: "MCP 服务器",
              usage_note: "为 Agent 绑定 MCP 服务器后，运行时会自动注入该服务器暴露的全部工具（无需也无法在蓝图 tools 中声明它们）。清单项的 metadata.tool_names 只覆盖当前已连接的服务器，完整工具目录（含各工具的描述与只读标记）用 get_capability_detail 查看。",
              listItems: () => {
                const servers = runtime.service.listServers();
                // 已连接服务器的工具名分组（listAllTools 只覆盖活动连接；未连接的服务器为空数组）。
                const toolNamesByServer = new Map<string, string[]>();
                for (const tool of runtime.service.listAllTools().tools) {
                  const names = toolNamesByServer.get(tool.server_name);
                  if (names) names.push(tool.name);
                  else toolNamesByServer.set(tool.server_name, [tool.name]);
                }
                return servers.map((server) => ({
                  name: server.name,
                  display_name: server.display_name || server.name,
                  metadata: { tool_names: toolNamesByServer.get(server.name) ?? [] },
                }));
              },
              getItemDetail: async (name) => {
                const server = runtime.service.listServers().find((item) => item.name === name);
                if (!server) return null;
                // 下钻是显式动作，按需拉起该服务器；失败不阻断，状态照实透出。
                await runtime.service.ensureServersReady([name]).catch(() => undefined);
                const status = runtime.service.getServerStatus(name);
                const { tools } = runtime.service.listServerTools(name);
                return {
                  name: server.name,
                  display_name: server.display_name || server.name,
                  detail: {
                    connection_status: status.status,
                    enabled: server.enabled,
                    transport: server.transport,
                    ...(status.error_message ? { connection_error: status.error_message } : {}),
                    tools: tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description,
                      read_only: tool.annotations?.readOnlyHint === true,
                      risk_level: tool.riskLevel,
                    })),
                    ...(tools.length === 0
                      ? { note: "该服务器当前没有可见工具（未连接或未暴露工具）；connection_status 说明原因。" }
                      : {}),
                  },
                };
              },
              getAgentConfig: async (teamName, agentName) =>
                (await runtime.agentConfig.getEffective({ teamName, agentName })).enabled_servers,
              putAgentConfig: async (teamName, agentName, names) => {
                await runtime.agentConfig.put(
                  { teamName, agentName },
                  { enabled_servers: [...names] },
                );
              },
            }, MCP_PLUGIN_ID),
          ],
          ...(runtime.dispose ? { dispose: () => runtime.dispose?.() } : {}),
        };
      });
      context.routes.register("tenant", "/api/mcp", async (app, routeContext) => {
        await app.register(
          registerMcpRoutes,
          routeContext.emitPluginEvent ? { emitPluginEvent: routeContext.emitPluginEvent } : {},
        );
      });
      context.routes.register("tenant", "/api/agent-config", async (app) => {
        await app.register(registerMcpAgentConfigRoutes);
      });
      context.tools.register(async ({ agent, teamName, capabilities }) => {
        if (!capabilities) throw new Error("MCP plugin requires runtime capabilities");
        const runtime = capabilities.require(MCP_RUNTIME_CAPABILITY);
        await waitForReadiness(runtime.ready);
        const config = await runtime.agentConfig.getEffective({
          teamName: teamName ?? "default",
          agentName: agent.agent_name,
        });
        const enabledServers = config.enabled_servers;
        if (enabledServers.length) {
          // 对话开始前按需拉起该 agent 启用的服务器(auto_connect=false 的不再启动期常驻连接):
          // 未连接的并行建连,单台失败/超时只损失该服务器的工具,不阻塞本次对话。
          await runtime.service.ensureServersReady(enabledServers);
        }
        return createMcpTools({
          mcp: runtime.service,
          enabledServers,
        });
      });
    },
    start: () => dependencies.lifecycle?.start?.(),
    stop: () => dependencies.lifecycle?.stop?.(),
  };
}

async function waitForReadiness(ready: Promise<void>): Promise<void> {
  const configured = Number(process.env.MCP_SESSION_INIT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
