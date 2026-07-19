import type { FastifyPluginAsync } from "fastify";

import { ArtifactServiceError } from "../services/artifacts/artifact-service.js";
import { HttpError, httpErrorFrom, statusHttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { loadOwnedSession, loadOwnedSessionForResource } from "./session-owner.js";
import { resolveSessionApplication } from "./session-application.js";
import { resolveArtifactApplication } from "./artifact-application.js";

interface ArtifactParams {
  artifactId: string;
}

interface SessionQuery {
  session_id?: string;
}

export const registerArtifactRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const artifacts = await resolveArtifactApplication(options, request);
    const sessionId = await artifacts.getVisualizationSessionId(request.params.artifactId);
    await loadOwnedSessionForResource(request, sessionId, `未找到可视化 artifact: ${request.params.artifactId}`, sessions);
    try { return await artifacts.getVisualization(request.params.artifactId); } catch (error) { throw toHttpError(error); }
  });

  app.get<{ Querystring: SessionQuery }>("/visualizations", async (request) => {
    const sessionId = request.query.session_id?.trim();
    if (!sessionId) {
      throw new HttpError(400, "invalid_request", "session_id is required");
    }
    const sessions = await resolveSessionApplication(options, request);
    const artifacts = await resolveArtifactApplication(options, request);
    await loadOwnedSession(request, sessionId, sessions);
    return artifacts.listVisualizations(sessionId);
  });

  app.delete<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const artifacts = await resolveArtifactApplication(options, request);
    const sessionId = await artifacts.getVisualizationSessionId(request.params.artifactId);
    await loadOwnedSessionForResource(request, sessionId, `未找到可视化 artifact: ${request.params.artifactId}`, sessions);
    const deleted = await artifacts.deleteVisualization(request.params.artifactId);
    if (!deleted) {
      throw new HttpError(404, "not_found", `未找到可视化 artifact: ${request.params.artifactId}`);
    }
    return {
      deleted: true,
      artifact_id: request.params.artifactId,
    };
  });

  app.delete<{ Querystring: SessionQuery }>("/visualizations", async (request) => {
    const sessionId = request.query.session_id?.trim();
    if (!sessionId) {
      throw new HttpError(400, "invalid_request", "session_id is required");
    }
    const sessions = await resolveSessionApplication(options, request);
    const artifacts = await resolveArtifactApplication(options, request);
    await loadOwnedSession(request, sessionId, sessions);
    return { deleted_count: await artifacts.deleteSessionVisualizations(sessionId), session_id: sessionId };
  });
};

function toHttpError(error: unknown): HttpError {
  return httpErrorFrom(error, (e) =>
    e instanceof ArtifactServiceError ? statusHttpError(e.statusCode, e.message) : null,
  );
}
