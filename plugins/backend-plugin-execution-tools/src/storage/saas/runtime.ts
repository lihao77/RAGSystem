import type { ExecutionToolsRuntimeFactory } from "../../dependencies.js";
import { findExecutionToolsSandbox } from "../../resources.js";
import { SaaSBashToolService, SaaSCodeExecutionService, SaaSSearchToolService } from "./sandbox-execution-tools.js";

export function createSandboxedExecutionToolsRuntimeFactory(): ExecutionToolsRuntimeFactory {
  return (context) => {
    const sandbox = findExecutionToolsSandbox(context.resources);
    if (!sandbox) return { bash: null, code: null, search: null };
    return { bash: new SaaSBashToolService(sandbox), code: new SaaSCodeExecutionService(sandbox), search: new SaaSSearchToolService(sandbox) };
  };
}
