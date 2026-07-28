import type { FastifyRequest } from "fastify";

import type { ArtifactApplication } from "./contracts/artifact-application.js";

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
  resolveArtifactApplication(request: FastifyRequest): ArtifactApplication | undefined | Promise<ArtifactApplication | undefined>;
  resolveArtifactApplicationForTenant(tenantId: string): ArtifactApplication | Promise<ArtifactApplication>;
  sessionAccess: ArtifactSessionAccess;
}
