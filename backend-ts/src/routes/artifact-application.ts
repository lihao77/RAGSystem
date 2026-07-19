import type { FastifyRequest } from "fastify";
import type { ArtifactApplication } from "../contracts/artifact-application.js";
import type { RouteOptions } from "./route-options.js";
import { ensureRequestApplications } from "../app/request-applications.js";

export async function resolveArtifactApplication(options: RouteOptions, request: FastifyRequest): Promise<ArtifactApplication> {
  return (await ensureRequestApplications(request, options)).artifacts;
}
