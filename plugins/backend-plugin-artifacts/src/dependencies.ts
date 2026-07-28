import type { FastifyRequest } from "fastify";

import type { ArtifactStorageProvider } from "./storage/storage-provider.js";

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
}
