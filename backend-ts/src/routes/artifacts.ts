import type { FastifyPluginAsync } from "fastify";

import { ArtifactServiceError } from "../services/artifacts/artifact-service.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface ArtifactParams {
  artifactId: string;
}

interface SessionQuery {
  session_id?: string;
}

export const registerArtifactRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    try {
      return options.container.artifacts.getVisualization(request.params.artifactId);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Querystring: SessionQuery }>("/visualizations", async (request) => {
    const sessionId = request.query.session_id?.trim();
    if (!sessionId) {
      throw new HttpError(400, "invalid_request", "session_id is required");
    }
    return options.container.artifacts.listVisualizations(sessionId);
  });

  app.delete<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    const deleted = options.container.artifacts.deleteVisualization(request.params.artifactId);
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
    return {
      deleted_count: options.container.artifacts.deleteSessionVisualizations(sessionId),
      session_id: sessionId,
    };
  });
};

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof ArtifactServiceError) {
    return new HttpError(error.statusCode, error.statusCode === 404 ? "not_found" : "invalid_request", error.message);
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}
