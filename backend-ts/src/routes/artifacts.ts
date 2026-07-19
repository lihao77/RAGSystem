import type { FastifyPluginAsync } from "fastify";

import { ArtifactServiceError } from "../services/artifacts/artifact-service.js";
import { HttpError, httpErrorFrom, statusHttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { loadOwnedSession, loadOwnedSessionForResource } from "./session-owner.js";
import { resolveSessionApplication } from "./session-application.js";

interface ArtifactParams {
  artifactId: string;
}

interface SessionQuery {
  session_id?: string;
}

export const registerArtifactRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const saas = await options.resolveSaaSArtifactService?.(request);
    if (saas) {
      const sessionId = await saas.getVisualizationSessionId(request.params.artifactId);
      await loadOwnedSessionForResource(request, sessionId, `未找到可视化 artifact: ${request.params.artifactId}`, sessions);
      try { return await saas.getVisualization(request.params.artifactId); } catch (error) { throw toHttpError(error); }
    }
    await loadOwnedSessionForResource(
      request,
      request.container.artifacts.getVisualizationSessionId(request.params.artifactId),
      `未找到可视化 artifact: ${request.params.artifactId}`,
      sessions,
    );
    try {
      return request.container.artifacts.getVisualization(request.params.artifactId);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Querystring: SessionQuery }>("/visualizations", async (request) => {
    const sessionId = request.query.session_id?.trim();
    if (!sessionId) {
      throw new HttpError(400, "invalid_request", "session_id is required");
    }
    const saas = await options.resolveSaaSArtifactService?.(request);
    const sessions = await resolveSessionApplication(options, request);
    await loadOwnedSession(request, sessionId, sessions);
    if (saas) return saas.listVisualizations(sessionId);
    return request.container.artifacts.listVisualizations(sessionId);
  });

  app.delete<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const saas = await options.resolveSaaSArtifactService?.(request);
    if (saas) {
      const sessionId = await saas.getVisualizationSessionId(request.params.artifactId);
      await loadOwnedSessionForResource(request, sessionId, `未找到可视化 artifact: ${request.params.artifactId}`, sessions);
      const deleted = await saas.deleteVisualization(request.params.artifactId);
      if (!deleted) throw new HttpError(404, "not_found", `未找到可视化 artifact: ${request.params.artifactId}`);
      return { deleted: true, artifact_id: request.params.artifactId };
    }
    await loadOwnedSessionForResource(
      request,
      request.container.artifacts.getVisualizationSessionId(request.params.artifactId),
      `未找到可视化 artifact: ${request.params.artifactId}`,
      sessions,
    );
    const deleted = request.container.artifacts.deleteVisualization(request.params.artifactId);
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
    const saas = await options.resolveSaaSArtifactService?.(request);
    const sessions = await resolveSessionApplication(options, request);
    await loadOwnedSession(request, sessionId, sessions);
    if (saas) return { deleted_count: await saas.deleteSessionVisualizations(sessionId), session_id: sessionId };
    return {
      deleted_count: request.container.artifacts.deleteSessionVisualizations(sessionId),
      session_id: sessionId,
    };
  });
};

function toHttpError(error: unknown): HttpError {
  return httpErrorFrom(error, (e) =>
    e instanceof ArtifactServiceError ? statusHttpError(e.statusCode, e.message) : null,
  );
}
