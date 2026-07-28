import type { ExecutionToolsRuntimeCapability } from "./capability.js";

export const EXECUTION_TOOLS_RUNTIME_RESOURCE = "execution-tools.runtime";
export const EXECUTION_TOOLS_ENABLED_RESOURCE = "execution-tools.enabled";

export function findExecutionToolsRuntimeResource(
  resources: readonly { kind: string; value: unknown }[] | undefined,
): ExecutionToolsRuntimeCapability | null {
  const value = resources?.find((resource) => resource.kind === EXECUTION_TOOLS_RUNTIME_RESOURCE)?.value;
  if (!value || typeof value !== "object") return null;
  return value as ExecutionToolsRuntimeCapability;
}
