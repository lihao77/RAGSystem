import type { DocumentToolsRuntimeCapability } from "./capability.js";
import type { FileEditHistoryPort } from "@ragsystem/backend-core/contracts/file-history-store/index.js";
import type { BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { BACKEND_HOST_RESOURCES, findBackendPluginResource, type BackendToolPolicyResource } from "@ragsystem/backend-core/plugins/host-resources.js";
import type { SandboxLeaseRuntime } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";

export function findDocumentToolsSandbox(
  resources: readonly BackendPluginResourceContribution[] | undefined,
): SandboxLeaseRuntime | null {
  return findBackendPluginResource<SandboxLeaseRuntime>(resources, BACKEND_HOST_RESOURCES.sandboxLease) ?? null;
}

export function documentToolsEnabled(
  resources: readonly BackendPluginResourceContribution[] | undefined,
): boolean {
  return findBackendPluginResource<BackendToolPolicyResource>(resources, BACKEND_HOST_RESOURCES.toolPolicy)?.executionToolsEnabled ?? true;
}

export function findDocumentEditHistoryResource(
  resources: readonly BackendPluginResourceContribution[] | undefined,
): FileEditHistoryPort | null {
  return findBackendPluginResource<FileEditHistoryPort>(resources, BACKEND_HOST_RESOURCES.fileEditHistory) ?? null;
}

export type { DocumentToolsRuntimeCapability };
