import type { FastifyRequest } from "fastify";
import type { ArtifactApplication } from "../contracts/artifact-application.js";
import { LocalArtifactApplication } from "../adapters/local/local-artifact-application.js";
import type { RouteOptions } from "./route-options.js";

export async function resolveArtifactApplication(options: RouteOptions, request: FastifyRequest): Promise<ArtifactApplication> {
  return await options.resolveArtifactApplication?.(request)
    ?? new LocalArtifactApplication(request.container.artifacts);
}
