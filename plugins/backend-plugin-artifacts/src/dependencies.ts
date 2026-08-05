import type { FastifyRequest } from "fastify";

import type { ArtifactApplication } from "./contracts/artifact-application.js";
import type { ArtifactStorageProvider } from "./storage/storage-provider.js";
import type { ArtifactStagingProvider } from "./staging/contracts.js";
import { createBackendResourceToken } from "@ragsystem/backend-core/plugins/resource-registry.js";

export const ARTIFACT_APPLICATION_RESOURCE = createBackendResourceToken<ArtifactAccessResource>(
  "ragsystem.artifact-application",
  "@ragsystem/backend-plugin-artifacts",
);
export const ARTIFACT_APPLICATION_RESOURCE_KIND = ARTIFACT_APPLICATION_RESOURCE;

/** Tenant-scoped read/write application exposed to other plugins through the resource registry. */
export type ArtifactApplicationResource = (
  tenantId: string,
) => ArtifactApplication | Promise<ArtifactApplication>;

export interface ArtifactAccessResource {
  applicationForTenant(tenantId: string): ArtifactApplication | Promise<ArtifactApplication>;
  assertReadable(request: FastifyRequest, sessionId: string): Promise<void>;
}

export interface ArtifactSessionAccess {
  assertReadable(request: FastifyRequest, sessionId: string): Promise<void>;
  assertMutable(request: FastifyRequest, sessionId: string): Promise<void>;
  assertResourceReadable(
    request: FastifyRequest,
    sessionId: string | null,
    notFoundMessage: string,
  ): Promise<void>;
  assertResourceMutable(
    request: FastifyRequest,
    sessionId: string | null,
    notFoundMessage: string,
  ): Promise<void>;
}

export interface ArtifactsPluginDependencies {
  storage: ArtifactStorageProvider;
  sessionAccess: ArtifactSessionAccess;
  staging?: ArtifactStagingProvider;
}
