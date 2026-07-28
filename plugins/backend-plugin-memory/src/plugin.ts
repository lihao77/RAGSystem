import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import { MEMORY_RUNTIME_CAPABILITY } from "./capability.js";
import { MEMORY_SYSTEM_CONFIG_EXTENSION } from "./config.js";
import type { MemoryPluginDependencies, MemoryPluginRuntime } from "./dependencies.js";
import { registerMemoryRoutes } from "./routes.js";
import { createMemoryTools } from "./tools/MemoryTools.js";

export const MEMORY_PLUGIN_ID = "@ragsystem/backend-plugin-memory";

export function createMemoryPlugin(dependencies: MemoryPluginDependencies): BackendPlugin {
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
          configureHooks: (registry) => runtime.configureHooks(registry),
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
      context.tools.register(({ agent, capabilities }) => {
        if (!capabilities) throw new Error("Memory plugin requires runtime capabilities");
        return createMemoryTools({
          agent,
          memoryTools: capabilities.require(MEMORY_RUNTIME_CAPABILITY).tools,
        });
      });
    },
    start: () => dependencies.lifecycle?.start?.(),
    stop: () => dependencies.lifecycle?.stop?.(),
  };
}
