import path from "node:path";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { WorkspaceFileApplication } from "../../contracts/application/workspace-file-application.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { sendBufferedFileDownload } from "../file-route-utils.js";
import { loadReadableSession } from "../session-owner.js";
import { resolveSessionApplication } from "../session-application.js";

interface SessionParams { sessionId: string }
interface WorkspaceFileQuery { path?: string }

/** Download a durable file from the shared session workspace by its relative path. */
export const registerWorkspaceFileRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: SessionParams; Querystring: WorkspaceFileQuery }>("/sessions/:sessionId/workspace-files/content", async (request, reply) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
    const filePath = request.query.path?.trim();
    if (!filePath) throw new HttpError(400, "invalid_request", "path 参数不能为空");
    const files = await resolveWorkspaceFiles(options, request);
    const result = await files.read(request.params.sessionId, filePath);
    if (result.status === "not_found" || !result.body) {
      throw new HttpError(404, "not_found", "工作空间文件不存在");
    }
    return sendBufferedFileDownload({
      body: result.body,
      filename: path.posix.basename(result.path ?? filePath.replace(/\\/g, "/")),
      mime: result.contentType ?? "application/octet-stream",
      reply,
    });
  });
};

async function resolveWorkspaceFiles(options: RouteOptions, request: FastifyRequest): Promise<WorkspaceFileApplication> {
  const application = await options.resolveWorkspaceFileApplication?.(request);
  if (!application) throw new Error("workspace file application resolver returned no implementation");
  return application;
}
