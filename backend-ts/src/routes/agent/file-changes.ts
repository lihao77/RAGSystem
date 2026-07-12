import type { FastifyPluginAsync } from "fastify";

import { FileChangeService } from "../../services/sessions/file-change-service.js";
import type { RouteOptions } from "../route-options.js";

interface SessionParams {
  sessionId: string;
}

export const registerFileChangeRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const service = new FileChangeService(options.container.fileHistory);

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/file-changes", async (request) => ({
    success: true,
    ...service.getLatest(request.params.sessionId),
  }));
};
