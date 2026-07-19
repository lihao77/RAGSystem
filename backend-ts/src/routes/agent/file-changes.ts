import type { FastifyPluginAsync } from "fastify";

import { AsyncFileChangeService, FileChangeService } from "../../services/sessions/file-change-service.js";
import type { RouteOptions } from "../route-options.js";
import { loadOwnedSession } from "../session-owner.js";

interface SessionParams {
  sessionId: string;
}

export const registerFileChangeRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: SessionParams }>("/sessions/:sessionId/file-changes", async (request) => {
    const saas = await options.resolveSaaSSessionApplication?.(request);
    await loadOwnedSession(request, request.params.sessionId, saas);
    const asyncHistory = await options.resolveFileHistoryStorage?.(request);
    if (asyncHistory) {
      const service = new AsyncFileChangeService(asyncHistory);
      return { success: true, ...await service.getLatest(request.params.sessionId) };
    }
    const service = new FileChangeService(request.container.fileHistory);
    return { success: true, ...service.getLatest(request.params.sessionId) };
  });
};
