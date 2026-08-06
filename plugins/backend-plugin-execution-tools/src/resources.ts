import type { ExecutionToolsRuntimeCapability } from "./capability.js";
import { BACKEND_HOST_RESOURCES, findBackendPluginResource, type BackendToolPolicyResource } from "@ragsystem/backend-core/plugins/host-resources.js";
import type { BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/resource-registry.js";
import type { RunSandboxRuntime } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";

export function findExecutionToolsSandbox(
  resources: readonly BackendPluginResourceContribution[] | undefined,
): RunSandboxRuntime | null {
  return findBackendPluginResource<RunSandboxRuntime>(resources, BACKEND_HOST_RESOURCES.sandboxRuntime) ?? null;
}

export function executionToolsEnabled(
  resources: readonly BackendPluginResourceContribution[] | undefined,
): boolean {
  return findBackendPluginResource<BackendToolPolicyResource>(resources, BACKEND_HOST_RESOURCES.toolPolicy)?.executionToolsEnabled ?? true;
}

export type { ExecutionToolsRuntimeCapability };
