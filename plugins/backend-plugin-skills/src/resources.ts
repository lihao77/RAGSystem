import path from "node:path";

import type { BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/backend-plugin.js";

export const SKILL_SOURCE_RESOURCE_KIND = "ragsystem.skill-source";
export const ARTIFACT_STAGING_RESOURCE_KIND = "ragsystem.artifact-staging";

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
    if (resource.kind !== SKILL_SOURCE_RESOURCE_KIND) continue;
    if (typeof resource.value !== "string" || !path.isAbsolute(resource.value)) {
      throw new Error(`Skill source from '${resource.pluginId}' must be an absolute path`);
    }
    const root = path.normalize(resource.value);
    if (roots.has(root)) throw new Error(`Skill source is already registered: ${root}`);
    roots.add(root);
    sources.push({ root, sourceLabel: resource.pluginId });
  }
  return sources;
}

export function resolveArtifactStagingService(
  resources: readonly BackendPluginResourceContribution[],
  tenantId: string,
  dataRoot: string,
): ArtifactStagingServiceResource | null {
  const matches = resources.filter((resource) => resource.kind === ARTIFACT_STAGING_RESOURCE_KIND);
  if (!matches.length) return null;
  if (matches.length > 1) throw new Error("Artifact staging resource must be registered exactly once");
  const resource = matches[0]!;
  if (!isArtifactStagingProvider(resource.value)) {
    throw new Error(`Artifact staging resource from '${resource.pluginId}' is invalid`);
  }
  return resource.value.forTenant(tenantId, dataRoot);
}

function isArtifactStagingProvider(value: unknown): value is ArtifactStagingProviderResource {
  return typeof value === "object"
    && value !== null
    && "forTenant" in value
    && typeof value.forTenant === "function";
}
