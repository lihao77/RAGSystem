import type { BackendPlugin, PluginEventRegistrar } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";
import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";
import {
  AGENT_DELETED_EVENT,
  SESSION_DELETED_EVENT,
  TEAM_DELETED_EVENT,
  TEAM_RENAMED_EVENT,
  isAgentDeletedEvent,
  isSessionDeletedEvent,
  isTeamDeletedEvent,
  isTeamRenamedEvent,
} from "@ragsystem/backend-core/contracts/runtime/entity-lifecycle-events.js";

import { MEMORY_RUNTIME_CAPABILITY, type MemoryRuntimeCapability } from "./capability.js";
import { MEMORY_SYSTEM_CONFIG_EXTENSION } from "./config.js";
import type { MemoryPluginDependencies, MemoryPluginRuntime } from "./dependencies.js";
import { registerMemoryRoutes } from "./routes.js";
import { createMemoryTools } from "./tools/MemoryTools.js";

export const MEMORY_PLUGIN_ID = "@ragsystem/backend-plugin-memory";

export function createMemoryPlugin(dependencies: MemoryPluginDependencies): BackendPlugin {
  /** 应用级 registry 惰性捕获：register 阶段 registry 尚未创建。 */
  let lifecycleRegistry: RuntimeContainerRegistry | null = null;
  return {
    manifest: { id: MEMORY_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.runtimes.register(async (runtimeContext) => {
        const unregisterSystemConfig = runtimeContext.systemConfig.registerExtension(
          MEMORY_PLUGIN_ID,
          MEMORY_SYSTEM_CONFIG_EXTENSION,
        );
        let runtime: MemoryPluginRuntime;
        try {
          runtime = await dependencies.runtimeFactory(runtimeContext);
        } catch (error) {
          unregisterSystemConfig();
          throw error;
        }
        return {
          capabilities: [provideCapability(MEMORY_RUNTIME_CAPABILITY, runtime)],
          contextSources: runtime.contextSources,
          dispose: () => {
            try {
              runtime.dispose?.();
            } finally {
              unregisterSystemConfig();
            }
          },
        };
      });
      context.routes.register("tenant", "/api/memory", async (app) => {
        await app.register(registerMemoryRoutes);
      });
      context.tools.register(async ({ agent, teamName, capabilities }) => {
        if (!capabilities) throw new Error("Memory plugin requires runtime capabilities");
        const runtime = capabilities.require(MEMORY_RUNTIME_CAPABILITY);
        const config = await runtime.agentConfig.getEffective({
          teamName: teamName ?? "default",
          agentName: agent.agent_name,
        });
        return createMemoryTools({
          agent,
          config,
          memoryTools: runtime.tools,
        });
      });
      registerEntityLifecycleHandlers(context.events, () => lifecycleRegistry);
      context.applications.register((applicationContext) => {
        lifecycleRegistry = applicationContext.registry;
        return {
          dispose() {
            lifecycleRegistry = null;
          },
        };
      });
    },
    start: () => dependencies.lifecycle?.start?.(),
    stop: () => dependencies.lifecycle?.stop?.(),
  };
}

/**
 * 订阅实体生命周期事件，级联清理记忆。事件 payload 带 tenantId，
 * 经 registry.acquire 定位租户运行时后取本插件 capability 执行清理
 * （与 agent-builder 消费 agent.config.changed 的模式一致；
 * acquire 为引用计数，删除请求已持有租户 lease 时重入安全）。
 */
function registerEntityLifecycleHandlers(
  events: PluginEventRegistrar,
  resolveRegistry: () => RuntimeContainerRegistry | null,
): void {
  const withTenantMemory = async (
    tenantId: string,
    action: (runtime: MemoryRuntimeCapability) => Promise<unknown>,
  ): Promise<void> => {
    const registry = resolveRegistry();
    if (!registry) return;
    const lease = await registry.acquire(tenantId);
    try {
      await action(lease.runtime.pluginCapabilities.require(MEMORY_RUNTIME_CAPABILITY));
    } finally {
      lease.release();
    }
  };

  events.on(SESSION_DELETED_EVENT, async (payload) => {
    if (!isSessionDeletedEvent(payload)) return;
    await withTenantMemory(payload.tenantId, (runtime) => runtime.purge({ scope: "session", sessionId: payload.sessionId }));
  });
  events.on(AGENT_DELETED_EVENT, async (payload) => {
    if (!isAgentDeletedEvent(payload)) return;
    await withTenantMemory(payload.tenantId, (runtime) => runtime.purge({
      scope: "agent",
      teamName: payload.teamName,
      agentName: payload.agentName,
    }));
  });
  events.on(TEAM_DELETED_EVENT, async (payload) => {
    if (!isTeamDeletedEvent(payload)) return;
    await withTenantMemory(payload.tenantId, (runtime) => runtime.purge({ scope: "team", teamName: payload.teamName }));
  });
  events.on(TEAM_RENAMED_EVENT, async (payload) => {
    if (!isTeamRenamedEvent(payload)) return;
    await withTenantMemory(payload.tenantId, (runtime) => runtime.migrateTeam(payload.previousTeamName, payload.teamName));
  });
}
