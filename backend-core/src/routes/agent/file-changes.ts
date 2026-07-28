import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { FileChangeApplication } from "../../contracts/application/file-change-application.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { loadReadableSession } from "../session-owner.js";
import { resolveSessionApplication } from "../session-application.js";

interface SessionParams {
  sessionId: string;
}

interface FileChangesQuery {
  message_seq?: string;
}

export const registerFileChangeRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: SessionParams; Querystring: FileChangesQuery }>("/sessions/:sessionId/file-changes", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
    const fileChanges = await resolveFileChanges(options, request);
    return { success: true, ...await fileChanges.getLatest(request.params.sessionId, parseMessageSeq(request.query.message_seq)) };
  });
};

async function resolveFileChanges(options: RouteOptions, request: FastifyRequest): Promise<FileChangeApplication> {
  const application = await options.resolveFileChangeApplication?.(request);
  if (!application) throw new Error("file change application resolver returned no implementation");
  return application;
}

function parseMessageSeq(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const messageSeq = Number(value);
  if (!Number.isSafeInteger(messageSeq) || messageSeq <= 0) {
    throw new HttpError(400, "invalid_request", "message_seq 必须是正整数");
  }
  return messageSeq;
}
