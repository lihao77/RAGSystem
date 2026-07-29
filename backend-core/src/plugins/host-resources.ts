import type { BackendPluginResourceContribution } from "./backend-plugin.js";

/** Stable resource names exposed by Local/SaaS without depending on individual plugins. */
export const BACKEND_HOST_RESOURCES = Object.freeze({
  deployment: "ragsystem.host.deployment",
  controlPlane: "ragsystem.host.control-plane",
  applications: "ragsystem.host.applications",
  wsTickets: "ragsystem.host.ws-tickets",
  tenantDataRoot: "ragsystem.host.tenant-data-root",
  controlDatabase: "ragsystem.host.database.control",
  runtimeDatabase: "ragsystem.host.database.runtime",
  objectStorage: "ragsystem.host.object-storage",
  secrets: "ragsystem.host.secrets",
  leaderElection: "ragsystem.host.leader-election",
});

export function findBackendPluginResource<Value>(
  resources: readonly BackendPluginResourceContribution[] | undefined,
  kind: string,
): Value | undefined {
  const matches = resources?.filter((resource) => resource.kind === kind) ?? [];
  if (matches.length > 1) throw new Error(`Backend plugin resource '${kind}' has multiple providers`);
  return matches[0]?.value as Value | undefined;
}

export function requireBackendPluginResource<Value>(
  resources: readonly BackendPluginResourceContribution[] | undefined,
  kind: string,
): Value {
  const value = findBackendPluginResource<Value>(resources, kind);
  if (value === undefined) throw new Error(`Required backend plugin resource '${kind}' is not available`);
  return value;
}
