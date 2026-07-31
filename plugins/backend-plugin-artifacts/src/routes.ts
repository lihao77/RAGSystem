import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ArtifactsPluginDependencies } from "./dependencies.js";

interface ArtifactParams { artifactId: string; }
interface SessionQuery { session_id?: string; }

export const registerArtifactRoutes: FastifyPluginAsync<ArtifactsPluginDependencies> = async (app, dependencies) => {
  app.get<{ Params: ArtifactParams }>("/:artifactId", async (request) => {
    const artifacts = await dependencies.storage.applicationForTenant(requireTenantId(request));
    const sessionId = await artifacts.getArtifactSessionId(request.params.artifactId);
    await dependencies.sessionAccess.assertResourceReadable(request, sessionId, `未找到 artifact: ${request.params.artifactId}`);
    return artifacts.getArtifact(request.params.artifactId);
  });

  app.get<{ Params: ArtifactParams }>("/:artifactId/content", async (request, reply) => {
    const artifacts = await dependencies.storage.applicationForTenant(requireTenantId(request));
    const sessionId = await artifacts.getArtifactSessionId(request.params.artifactId);
    await dependencies.sessionAccess.assertResourceReadable(request, sessionId, `未找到 artifact: ${request.params.artifactId}`);
    const content = await artifacts.getArtifactContent(request.params.artifactId);
    if (!content) throw new PluginHttpError(404, `artifact 没有二进制内容: ${request.params.artifactId}`);
    reply.header("Content-Type", content.mimeType);
    reply.header("Content-Length", content.body.byteLength);
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    if (content.filename) reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(content.filename)}`);
    return reply.send(Buffer.from(content.body));
  });

  app.get<{ Querystring: SessionQuery }>("/", async (request) => {
    const sessionId = request.query.session_id?.trim(); if (!sessionId) throw new PluginHttpError(400, "session_id is required");
    await dependencies.sessionAccess.assertReadable(request, sessionId);
    return (await dependencies.storage.applicationForTenant(requireTenantId(request))).listArtifacts(sessionId);
  });

  app.delete<{ Params: ArtifactParams }>("/:artifactId", async (request) => {
    const artifacts = await dependencies.storage.applicationForTenant(requireTenantId(request)); const sessionId = await artifacts.getArtifactSessionId(request.params.artifactId);
    await dependencies.sessionAccess.assertResourceMutable(request, sessionId, `未找到 artifact: ${request.params.artifactId}`);
    if (!await artifacts.deleteArtifact(request.params.artifactId)) throw new PluginHttpError(404, `未找到 artifact: ${request.params.artifactId}`);
    return { deleted: true, artifact_id: request.params.artifactId };
  });

  app.delete<{ Querystring: SessionQuery }>("/", async (request) => {
    const sessionId = request.query.session_id?.trim(); if (!sessionId) throw new PluginHttpError(400, "session_id is required");
    await dependencies.sessionAccess.assertMutable(request, sessionId);
    return { deleted_count: await (await dependencies.storage.applicationForTenant(requireTenantId(request))).deleteSessionArtifacts(sessionId), session_id: sessionId };
  });
};

function requireTenantId(request: FastifyRequest): string { const tenantId = (request as FastifyRequest & { identity?: { tenantId?: unknown } }).identity?.tenantId; if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("Artifact plugin requires tenant identity"); return tenantId; }
class PluginHttpError extends Error { constructor(readonly statusCode: number, message: string) { super(message); this.name = "PluginHttpError"; } }
