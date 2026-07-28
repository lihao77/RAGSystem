import { LocalBashToolService } from "../../tools/BashTool/BashExecution.js";
import { CodeExecutionToolService } from "../../tools/CodeExecutionTool/CodeExecution.js";
import { LocalSearchToolService } from "../../tools/LocalSearchTools/SearchExecution.js";
import type { ExecutionToolsRuntimeFactory } from "../../dependencies.js";
import { EXECUTION_TOOLS_ENABLED_RESOURCE } from "../../resources.js";

export interface LocalExecutionToolsRuntimeFactoryOptions {
  enabled?: boolean;
}

export function createLocalExecutionToolsRuntimeFactory(
  options: LocalExecutionToolsRuntimeFactoryOptions = {},
): ExecutionToolsRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "local") {
      throw new Error("Local execution tools runtime requires a Local deployment");
    }
    const runtimeEnabled = context.resources?.find((resource) => resource.kind === EXECUTION_TOOLS_ENABLED_RESOURCE)?.value;
    if (options.enabled === false || runtimeEnabled === false) return { bash: null, code: null, search: null };
    const tools = context.systemConfig.getToolsConfig();
    return {
      bash: new LocalBashToolService({
        dataRoot: context.dataRoot,
        defaultTimeoutSeconds: tools.bash_default_timeout,
        maxTimeoutSeconds: tools.bash_max_timeout,
        maxOutputChars: tools.bash_max_output,
        backgroundTasks: context.backgroundTasks,
        clientEvents: context.clientEvents,
      }),
      code: new CodeExecutionToolService({
        dataRoot: context.dataRoot,
        defaultTimeoutSeconds: tools.code_default_timeout,
        maxTimeoutSeconds: tools.code_max_timeout,
      }),
      search: new LocalSearchToolService({ dataRoot: context.dataRoot }),
    };
  };
}
