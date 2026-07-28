import type { FastifyRequest } from "fastify";

import type { ArtifactApplication } from "@ragsystem/backend-core/contracts/artifacts/artifact-application.js";
import type { SessionApplication } from "@ragsystem/backend-core/contracts/session/session-application.js";

export interface ArtifactSessionAccess {
  loadReadableSession(request: FastifyRequest, sessionId: string, sessions: SessionApplication): Promise<unknown>;
  loadMutableSession(request: FastifyRequest, sessionId: string, sessions: SessionApplication): Promise<unknown>;
  loadReadableSessionForResource(
    request: FastifyRequest,
    sessionId: string | null,
    notFoundMessage: string,
    sessions: SessionApplication,
  ): Promise<unknown>;
  loadMutableSessionForResource(
    request: FastifyRequest,
    sessionId: string | null,
    notFoundMessage: string,
    sessions: SessionApplication,
  ): Promise<unknown>;
}

export interface ArtifactsPluginDependencies {
  resolveArtifactApplication(request: FastifyRequest): ArtifactApplication | undefined | Promise<ArtifactApplication | undefined>;
  resolveArtifactApplicationForTenant(tenantId: string): ArtifactApplication | Promise<ArtifactApplication>;
  resolveSessionApplication(request: FastifyRequest): SessionApplication | undefined | Promise<SessionApplication | undefined>;
  sessionAccess: ArtifactSessionAccess;
}
