import path from "node:path";
import type { FastifyRequest } from "fastify";

import type { BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/backend-plugin.js";

export const SKILL_SOURCE_RESOURCE_KIND = "ragsystem.skill-source";
export const ARTIFACT_STAGING_RESOURCE_KIND = "ragsystem.artifact-staging";
export const ARTIFACT_APPLICATION_RESOURCE_KIND = "ragsystem.artifact-application";

/** Structural read-only port; the Skills plugin does not depend on Artifact storage. */
export interface SkillArtifactApplication {
  getArtifact(artifactId: string): Promise<{
    artifact_id: string;
    revision: number;
    session_id: string;
    kind: string;
    title: string;
    status: "ready" | "failed";
    assets: Array<{ asset_id: string; filename: string; media_type: string; size: number; sha256: string }>;
    metadata: Record<string, unknown>;
    provenance: Record<string, unknown>;
  }>;
  getArtifactAsset(artifactId: string, assetId: string): Promise<{
    body: Uint8Array;
    mediaType: string;
    filename: string;
    sha256: string;
  }>;
}

/** Tenant-scoped Artifact port exposed by the Artifacts plugin. */
export interface SkillArtifactResource {
  applicationForTenant(tenantId: string): SkillArtifactApplication | Promise<SkillArtifactApplication>;
  assertReadable(request: FastifyRequest, sessionId: string): Promise<void>;
}

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

export async function resolveArtifactApplication(
  resources: readonly BackendPluginResourceContribution[],
  tenantId: string,
): Promise<SkillArtifactApplication | null> {
  const matches = resources.filter((resource) => resource.kind === ARTIFACT_APPLICATION_RESOURCE_KIND);
  if (!matches.length) return null;
  if (matches.length > 1) throw new Error("Artifact application resource must be registered exactly once");
  const provider = matches[0]!.value;
  if (!isSkillArtifactResource(provider)) {
    throw new Error(`Artifact application resource from '${matches[0]!.pluginId}' is invalid`);
  }
  const application = await provider.applicationForTenant(tenantId);
  return application;
}

export function resolveArtifactResource(
  resources: readonly BackendPluginResourceContribution[],
): SkillArtifactResource | null {
  const matches = resources.filter((resource) => resource.kind === ARTIFACT_APPLICATION_RESOURCE_KIND);
  if (!matches.length) return null;
  if (matches.length > 1) throw new Error("Artifact application resource must be registered exactly once");
  const provider = matches[0]!.value;
  if (!isSkillArtifactResource(provider)) {
    throw new Error(`Artifact application resource from '${matches[0]!.pluginId}' is invalid`);
  }
  return provider;
}

function isSkillArtifactResource(value: unknown): value is SkillArtifactResource {
  return typeof value === "object"
    && value !== null
    && "applicationForTenant" in value
    && typeof value.applicationForTenant === "function"
    && "assertReadable" in value
    && typeof value.assertReadable === "function";
}

function isArtifactStagingProvider(value: unknown): value is ArtifactStagingProviderResource {
  return typeof value === "object"
    && value !== null
    && "forTenant" in value
    && typeof value.forTenant === "function";
}
