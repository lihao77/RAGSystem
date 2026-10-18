import type { ExecutionToolsRuntimeFactory } from "../../dependencies.js";
import { findExecutionToolsSandbox } from "../../resources.js";
import { SandboxBashToolService, SandboxCodeExecutionService, SandboxSearchToolService } from "./sandbox-execution-tools.js";

export function createSandboxedExecutionToolsRuntimeFactory(): ExecutionToolsRuntimeFactory {
  return (context) => {
    const sandbox = findExecutionToolsSandbox(context.resources);
    if (!sandbox) return { bash: null, code: null, search: null };
    return { bash: new SandboxBashToolService(sandbox), code: new SandboxCodeExecutionService(sandbox), search: new SandboxSearchToolService(sandbox) };
  };
}
