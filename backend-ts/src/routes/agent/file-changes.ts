import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { FileChangeApplication } from "../../contracts/application/file-change-application.js";
import type { RouteOptions } from "../route-options.js";
import { loadOwnedSession } from "../session-owner.js";
import { resolveSessionApplication } from "../session-application.js";

interface SessionParams {
  sessionId: string;
}

export const registerFileChangeRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: SessionParams }>("/sessions/:sessionId/file-changes", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadOwnedSession(request, request.params.sessionId, sessions);
    const fileChanges = await resolveFileChanges(options, request);
    return { success: true, ...await fileChanges.getLatest(request.params.sessionId) };
  });
};

async function resolveFileChanges(options: RouteOptions, request: FastifyRequest): Promise<FileChangeApplication> {
  const application = await options.resolveFileChangeApplication?.(request);
  if (!application) throw new Error("file change application resolver returned no implementation");
  return application;
}
