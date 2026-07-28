import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { ArtifactApplication } from "@ragsystem/backend-core/contracts/artifacts/artifact-application.js";
import type { SessionApplication } from "@ragsystem/backend-core/contracts/session/session-application.js";
import type { ArtifactsPluginDependencies } from "./dependencies.js";

interface ArtifactParams {
  artifactId: string;
}

interface SessionQuery {
  session_id?: string;
}

export const registerArtifactRoutes: FastifyPluginAsync<ArtifactsPluginDependencies> = async (app, dependencies) => {
  app.get<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    const { sessions, artifacts } = await resolveApplications(request, dependencies);
    const sessionId = await artifacts.getVisualizationSessionId(request.params.artifactId);
    await dependencies.sessionAccess.loadReadableSessionForResource(
      request,
      sessionId,
      `未找到可视化 artifact: ${request.params.artifactId}`,
      sessions,
    );
    return artifacts.getVisualization(request.params.artifactId);
  });

  app.get<{ Querystring: SessionQuery }>("/visualizations", async (request) => {
    const sessionId = request.query.session_id?.trim();
    if (!sessionId) throw new PluginHttpError(400, "session_id is required");
    const { sessions, artifacts } = await resolveApplications(request, dependencies);
    await dependencies.sessionAccess.loadReadableSession(request, sessionId, sessions);
    return artifacts.listVisualizations(sessionId);
  });

  app.delete<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    const { sessions, artifacts } = await resolveApplications(request, dependencies);
    const sessionId = await artifacts.getVisualizationSessionId(request.params.artifactId);
    await dependencies.sessionAccess.loadMutableSessionForResource(
      request,
      sessionId,
      `未找到可视化 artifact: ${request.params.artifactId}`,
      sessions,
    );
    const deleted = await artifacts.deleteVisualization(request.params.artifactId);
    if (!deleted) throw new PluginHttpError(404, `未找到可视化 artifact: ${request.params.artifactId}`);
    return { deleted: true, artifact_id: request.params.artifactId };
  });

  app.delete<{ Querystring: SessionQuery }>("/visualizations", async (request) => {
    const sessionId = request.query.session_id?.trim();
    if (!sessionId) throw new PluginHttpError(400, "session_id is required");
    const { sessions, artifacts } = await resolveApplications(request, dependencies);
    await dependencies.sessionAccess.loadMutableSession(request, sessionId, sessions);
    return { deleted_count: await artifacts.deleteSessionVisualizations(sessionId), session_id: sessionId };
  });
};

async function resolveApplications(
  request: FastifyRequest,
  dependencies: ArtifactsPluginDependencies,
): Promise<{ artifacts: ArtifactApplication; sessions: SessionApplication }> {
  const [artifacts, sessions] = await Promise.all([
    dependencies.resolveArtifactApplication(request),
    dependencies.resolveSessionApplication(request),
  ]);
  if (!artifacts) throw new Error("Artifact application resolver returned no implementation");
  if (!sessions) throw new Error("Session application resolver returned no implementation");
  return { artifacts, sessions };
}

class PluginHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "PluginHttpError";
  }
}
