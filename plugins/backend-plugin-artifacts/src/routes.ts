import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { ArtifactsPluginDependencies } from "./dependencies.js";

interface ArtifactParams {
  artifactId: string;
}

interface SessionQuery {
  session_id?: string;
}

export const registerArtifactRoutes: FastifyPluginAsync<ArtifactsPluginDependencies> = async (app, dependencies) => {
  app.get<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    const artifacts = await dependencies.storage.applicationForTenant(requireTenantId(request));
    const sessionId = await artifacts.getVisualizationSessionId(request.params.artifactId);
    await dependencies.sessionAccess.assertResourceReadable(
      request,
      sessionId,
      `未找到可视化 artifact: ${request.params.artifactId}`,
    );
    return artifacts.getVisualization(request.params.artifactId);
  });

  app.get<{ Querystring: SessionQuery }>("/visualizations", async (request) => {
    const sessionId = request.query.session_id?.trim();
    if (!sessionId) throw new PluginHttpError(400, "session_id is required");
    const artifacts = await dependencies.storage.applicationForTenant(requireTenantId(request));
    await dependencies.sessionAccess.assertReadable(request, sessionId);
    return artifacts.listVisualizations(sessionId);
  });

  app.delete<{ Params: ArtifactParams }>("/visualizations/:artifactId", async (request) => {
    const artifacts = await dependencies.storage.applicationForTenant(requireTenantId(request));
    const sessionId = await artifacts.getVisualizationSessionId(request.params.artifactId);
    await dependencies.sessionAccess.assertResourceMutable(
      request,
      sessionId,
      `未找到可视化 artifact: ${request.params.artifactId}`,
    );
    const deleted = await artifacts.deleteVisualization(request.params.artifactId);
    if (!deleted) throw new PluginHttpError(404, `未找到可视化 artifact: ${request.params.artifactId}`);
    return { deleted: true, artifact_id: request.params.artifactId };
  });

  app.delete<{ Querystring: SessionQuery }>("/visualizations", async (request) => {
    const sessionId = request.query.session_id?.trim();
    if (!sessionId) throw new PluginHttpError(400, "session_id is required");
    const artifacts = await dependencies.storage.applicationForTenant(requireTenantId(request));
    await dependencies.sessionAccess.assertMutable(request, sessionId);
    return { deleted_count: await artifacts.deleteSessionVisualizations(sessionId), session_id: sessionId };
  });
};

function requireTenantId(request: FastifyRequest): string {
  const tenantId = (request as FastifyRequest & { identity?: { tenantId?: unknown } }).identity?.tenantId;
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("Artifact plugin requires tenant identity");
  return tenantId;
}

class PluginHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "PluginHttpError";
  }
}
