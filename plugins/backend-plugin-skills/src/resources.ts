import path from "node:path";

import {
  createBackendResourceToken,
  findBackendResource,
  requireBackendResource,
  type BackendPluginResourceContribution,
} from "@ragsystem/backend-core/plugins/resource-registry.js";

export const SKILL_SOURCE_RESOURCE = createBackendResourceToken<string>(
  "ragsystem.skill-source",
  "@ragsystem/backend-plugin-skills",
);
export const SKILL_SOURCE_RESOURCE_KIND = SKILL_SOURCE_RESOURCE;
export const ARTIFACT_STAGING_RESOURCE = createBackendResourceToken<ArtifactStagingProviderResource>(
  "ragsystem.artifact-staging",
  "@ragsystem/backend-plugin-artifacts",
);
export const ARTIFACT_STAGING_RESOURCE_KIND = ARTIFACT_STAGING_RESOURCE;

export interface ArtifactStagingRunResource {
  stageRunId: string;
  outputDirectory: string;
}

export interface ArtifactStagedFileResource {
  stagedFileId: string;
  filename: string;
  mediaType: string | null;
  size: number;
  sha256: string;
}

export interface ArtifactStagingServiceResource {
  createRun(context: {
    sessionId: string;
    runId: string | null;
    toolCallId: string | null;
  }): Promise<ArtifactStagingRunResource>;
  registerOutputs(
    stageRunId: string,
    outputs: readonly {
      relativePath: string;
      filename?: string | null;
      mediaType?: string | null;
    }[],
  ): Promise<readonly ArtifactStagedFileResource[]>;
  discardRun(stageRunId: string): Promise<void>;
}

interface ArtifactStagingProviderResource {
  forTenant(tenantId: string, dataRoot: string): ArtifactStagingServiceResource;
}

export function resolveBuiltinSkillSources(
  resources: readonly BackendPluginResourceContribution[],
): Array<{ root: string; sourceLabel: string }> {
  const roots = new Set<string>();
  const sources: Array<{ root: string; sourceLabel: string }> = [];
  for (const resource of resources) {
    if (resource.token.id !== SKILL_SOURCE_RESOURCE.id) continue;
    if (typeof resource.value !== "string" || !path.isAbsolute(resource.value)) {
      throw new Error(`Skill source from '${resource.providerId}' must be an absolute path`);
    }
    const root = path.normalize(resource.value);
    if (roots.has(root)) throw new Error(`Skill source is already registered: ${root}`);
    roots.add(root);
    sources.push({ root, sourceLabel: resource.providerId });
  }
  return sources;
}

export function resolveArtifactStagingService(
  resources: readonly BackendPluginResourceContribution[],
  tenantId: string,
  dataRoot: string,
): ArtifactStagingServiceResource | null {
  const resource = findBackendResource(resources, ARTIFACT_STAGING_RESOURCE);
  if (!resource) return null;
  if (!isArtifactStagingProvider(resource)) {
    throw new Error("Artifact staging resource is invalid");
  }
  return resource.forTenant(tenantId, dataRoot);
}

function isArtifactStagingProvider(value: unknown): value is ArtifactStagingProviderResource {
  return typeof value === "object"
    && value !== null
    && "forTenant" in value
    && typeof value.forTenant === "function";
}
