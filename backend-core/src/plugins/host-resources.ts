import {
  createBackendResourceToken,
  findBackendResource,
  requireBackendResource,
  type BackendPluginResourceContribution,
  type BackendResourceToken,
} from "./resource-registry.js";
import type { FileEditHistoryPort } from "../contracts/file-history-store/index.js";
import type { RunSandboxRuntime } from "../contracts/sandbox/sandbox-provider.js";

export type BackendDeploymentResource = { kind: "local" | "saas" };
export interface BackendToolPolicyResource {
  readonly executionToolsEnabled: boolean;
}

/** Typed host capabilities exposed by Local/SaaS without depending on individual plugins. */
export const BACKEND_HOST_RESOURCES = Object.freeze({
  deployment: createBackendResourceToken<BackendDeploymentResource>("ragsystem.host.deployment", "ragsystem.backend-core"),
  controlPlane: createBackendResourceToken<unknown>("ragsystem.host.control-plane", "ragsystem.backend-core"),
  applications: createBackendResourceToken<unknown>("ragsystem.host.applications", "ragsystem.backend-core"),
  wsTickets: createBackendResourceToken<unknown>("ragsystem.host.ws-tickets", "ragsystem.backend-core"),
  tenantDataRoot: createBackendResourceToken<(tenantId: string) => string>("ragsystem.host.tenant-data-root", "ragsystem.backend-core"),
  controlDatabase: createBackendResourceToken<unknown>("ragsystem.host.database.control", "ragsystem.backend-core"),
  runtimeDatabase: createBackendResourceToken<unknown>("ragsystem.host.database.runtime", "ragsystem.backend-core"),
  objectStorage: createBackendResourceToken<unknown>("ragsystem.host.object-storage", "ragsystem.backend-core"),
  secrets: createBackendResourceToken<unknown>("ragsystem.host.secrets", "ragsystem.backend-core"),
  leaderElection: createBackendResourceToken<unknown>("ragsystem.host.leader-election", "ragsystem.backend-core"),
  toolPolicy: createBackendResourceToken<BackendToolPolicyResource>("ragsystem.host.tool-policy", "ragsystem.backend-core"),
  fileEditHistory: createBackendResourceToken<FileEditHistoryPort>("ragsystem.host.file-edit-history", "ragsystem.backend-core"),
  sandboxRuntime: createBackendResourceToken<RunSandboxRuntime>("ragsystem.host.sandbox-runtime", "ragsystem.backend-core"),
});

export function findBackendPluginResource<Value>(
  resources: readonly BackendPluginResourceContribution[] | undefined,
  token: BackendResourceToken<unknown>,
): Value | undefined {
  return findBackendResource(resources, token);
}

export function requireBackendPluginResource<Value>(
  resources: readonly BackendPluginResourceContribution[] | undefined,
  token: BackendResourceToken<unknown>,
): Value {
  return requireBackendResource(resources, token);
}
