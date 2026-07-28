import type { BackendPlugin, BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import { EXECUTION_TOOLS_RUNTIME_CAPABILITY } from "./capability.js";
import type { ExecutionToolsPluginDependencies } from "./dependencies.js";
import { createBashTools } from "./tools/BashTool/BashTool.js";
import { createCodeExecutionTools } from "./tools/CodeExecutionTool/CodeExecutionTool.js";
import { createLocalSearchTools } from "./tools/LocalSearchTools/LocalSearchTools.js";

export const EXECUTION_TOOLS_PLUGIN_ID = "@ragsystem/backend-plugin-execution-tools";

const TOOL_DESCRIPTORS: readonly BackendToolDescriptor[] = [
  { name: "glob", description: "Find files in the managed workspace using glob patterns", category: "filesystem", risk_level: "low" },
  { name: "grep", description: "Search text in managed workspace files", category: "filesystem", risk_level: "low" },
  { name: "web_fetch", description: "Fetch HTTP/HTTPS content as readable text", category: "network", risk_level: "medium" },
  { name: "todo_write", description: "Replace the current session todo list", category: "task", risk_level: "low" },
  { name: "execute_bash", description: "Execute a foreground shell command with approval boundaries", category: "execution", risk_level: "high" },
  { name: "execute_code", description: "Execute Python code in a restricted sandbox", category: "execution", risk_level: "high" },
];

export function createExecutionToolsPlugin(dependencies: ExecutionToolsPluginDependencies): BackendPlugin {
  return {
    manifest: { id: EXECUTION_TOOLS_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.runtimes.register(async (runtimeContext) => {
        const runtime = await dependencies.runtimeFactory(runtimeContext);
        return {
          capabilities: [provideCapability(EXECUTION_TOOLS_RUNTIME_CAPABILITY, runtime)],
          ...(runtime.dispose ? { dispose: () => runtime.dispose?.() } : {}),
        };
      });
      context.tools.register(({ agent, pathAccessPolicy, capabilities, callTool }) => {
        if (!capabilities) throw new Error("Execution tools plugin requires runtime capabilities");
        const runtime = capabilities.require(EXECUTION_TOOLS_RUNTIME_CAPABILITY);
        return [
          ...createBashTools({ bashTools: runtime.bash, agent, pathService: pathAccessPolicy }),
          ...createCodeExecutionTools({
            codeExecutionTools: runtime.code,
            agent,
            ...(callTool ? {
              callTool: (toolName, args, toolContext) => callTool(toolName, args, {
                ...toolContext,
                caller: "code_execution",
              }),
            } : {}),
          }),
          ...createLocalSearchTools({ service: runtime.search, agent }),
        ];
      }, TOOL_DESCRIPTORS);
    },
  };
}
