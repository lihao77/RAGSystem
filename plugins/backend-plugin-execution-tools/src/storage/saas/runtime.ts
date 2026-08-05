import type { ExecutionToolsRuntimeFactory } from "../../dependencies.js";
import { findExecutionToolsSandbox } from "../../resources.js";
import { SaaSBashToolService, SaaSCodeExecutionService, SaaSSearchToolService } from "./sandbox-execution-tools.js";

export function createSaaSExecutionToolsRuntimeFactory(): ExecutionToolsRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "saas") {
      throw new Error("SaaS execution tools runtime requires a SaaS deployment");
    }
    const sandbox = findExecutionToolsSandbox(context.resources);
    return sandbox
      ? { bash: new SaaSBashToolService(sandbox), code: new SaaSCodeExecutionService(sandbox), search: new SaaSSearchToolService(sandbox) }
      : { bash: null, code: null, search: null };
  };
}
