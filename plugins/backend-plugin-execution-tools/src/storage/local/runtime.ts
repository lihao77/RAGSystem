import { setHostShellOverrideResolver } from "@ragsystem/backend-core/contracts/execution/shell-detection.js";

import { LocalBashToolService } from "../../tools/BashTool/BashExecution.js";
import { CodeExecutionToolService } from "../../tools/CodeExecutionTool/CodeExecution.js";
import { LocalSearchToolService } from "../../tools/LocalSearchTools/SearchExecution.js";
import { ManagedPathResolver } from "../../paths/managed-path-resolver.js";
import { EXECUTION_TOOLS_PLUGIN_ID } from "../../plugin.js";
import type { ExecutionToolsRuntimeFactory } from "../../dependencies.js";
import { executionToolsEnabled } from "../../resources.js";
import {
  createExecutionToolsSystemConfigExtension,
  readHostShellOverride,
} from "../../system-config.js";

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
    if (options.enabled === false || !executionToolsEnabled(context.resources)) return { bash: null, code: null, search: null };
    // 终端执行环境设置组（插件设置）：本工厂只服务本地宿主执行，沙箱运行时不注册。
    const unregisterSystemConfig = context.systemConfig.registerExtension(
      EXECUTION_TOOLS_PLUGIN_ID,
      createExecutionToolsSystemConfigExtension(),
    );
    try {
      // 宿主终端类型覆盖：惰性读取设置组——shell-detection 每次解析都现调 resolver，
      // execute_shell 实际执行与提示词"运行环境"段同源，设置变更后即刻生效。
      setHostShellOverrideResolver(() => readHostShellOverride(context.systemConfig));
      const tools = context.systemConfig.getToolsConfig();
      const pathResolver = new ManagedPathResolver(context.dataRoot);
      return {
        bash: new LocalBashToolService({
          dataRoot: context.dataRoot,
          pathResolver,
          defaultTimeoutSeconds: tools.bash_default_timeout,
          maxTimeoutSeconds: tools.bash_max_timeout,
          maxOutputChars: tools.bash_max_output,
          backgroundTasks: context.backgroundTasks,
          clientEvents: context.clientEvents,
        }),
        code: new CodeExecutionToolService({
          dataRoot: context.dataRoot,
          pathResolver,
          defaultTimeoutSeconds: tools.code_default_timeout,
          maxTimeoutSeconds: tools.code_max_timeout,
        }),
        search: new LocalSearchToolService({ dataRoot: context.dataRoot, pathResolver }),
        dispose: () => {
          try {
            setHostShellOverrideResolver(null);
          } finally {
            unregisterSystemConfig();
          }
        },
      };
    } catch (error) {
      setHostShellOverrideResolver(null);
      unregisterSystemConfig();
      throw error;
    }
  };
}
