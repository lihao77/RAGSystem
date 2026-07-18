import type { FastifyPluginAsync } from "fastify";

import { FileChangeService } from "../../services/sessions/file-change-service.js";
import type { RouteOptions } from "../route-options.js";
import { loadOwnedSession } from "../session-owner.js";

interface SessionParams {
  sessionId: string;
}

export const registerFileChangeRoutes: FastifyPluginAsync<RouteOptions> = async (app) => {
  app.get<{ Params: SessionParams }>("/sessions/:sessionId/file-changes", async (request) => {
    await loadOwnedSession(request, request.params.sessionId);
    const service = new FileChangeService(request.container.fileHistory);
    return { success: true, ...service.getLatest(request.params.sessionId) };
  });
};
