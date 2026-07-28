import type { ExecutionToolsRuntimeFactory } from "../../dependencies.js";
import { findExecutionToolsRuntimeResource } from "../../resources.js";

export function createSaaSExecutionToolsRuntimeFactory(): ExecutionToolsRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "saas") {
      throw new Error("SaaS execution tools runtime requires a SaaS deployment");
    }
    return findExecutionToolsRuntimeResource(context.resources)
      ?? { bash: null, code: null, search: null };
  };
}
