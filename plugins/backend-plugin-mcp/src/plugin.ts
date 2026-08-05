import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import { MCP_RUNTIME_CAPABILITY } from "./capability.js";
import type { McpPluginDependencies } from "./dependencies.js";
import { registerMcpAgentConfigRoutes, registerMcpRoutes } from "./routes.js";
import { createMcpTools } from "./tools/McpTools.js";

export const MCP_PLUGIN_ID = "@ragsystem/backend-plugin-mcp";

export function createMcpPlugin(dependencies: McpPluginDependencies): BackendPlugin {
  return {
    manifest: { id: MCP_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.runtimes.register(async (runtimeContext) => {
        const runtime = await dependencies.runtimeFactory(runtimeContext);
        return {
          capabilities: [provideCapability(MCP_RUNTIME_CAPABILITY, runtime)],
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
        return createMcpTools({
          mcp: runtime.service,
          enabledServers: config.enabled_servers,
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
