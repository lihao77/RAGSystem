import type { FastifyPluginAsync } from "fastify";

import { ValidateFilesRequestSchema } from "../../contracts/files.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import {
  collectMultipartFiles,
  removeStoredFile,
  sendFileDownload,
  validateFileIds,
} from "../file-route-utils.js";
import { loadOwnedSession } from "../session-owner.js";

interface SessionParams {
  sessionId: string;
}

interface SessionFileParams extends SessionParams {
  fileId: string;
}

export const registerSessionFileRoutes: FastifyPluginAsync<RouteOptions> = async (app) => {
  app.get<{ Params: SessionParams }>("/sessions/:sessionId/files", async (request) => {
    await loadOwnedSession(request, request.params.sessionId);
    return {
      success: true,
      files: request.container.fileIndex.list({
        scopeType: "session",
        scopeId: request.params.sessionId,
      }),
    };
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/files/validate", async (request) => {
    await loadOwnedSession(request, request.params.sessionId);
    const payload = ValidateFilesRequestSchema.parse(request.body);
    return validateFileIds({
      fileIndex: request.container.fileIndex,
      fileIds: payload.file_ids,
      scope: { scopeType: "session", scopeId: request.params.sessionId },
    });
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/files/upload", async (request) => {
    await loadOwnedSession(request, request.params.sessionId);
    const parts = await collectMultipartFiles(request);
    const sessionId = request.params.sessionId;
    const files = parts.map((part) =>
      request.container.fileIndex.add({
        originalName: part.filename,
        buffer: part.buffer,
        mime: part.mime,
        scopeType: "session",
        scopeId: sessionId,
      }),
    );
    return { success: true, files };
  });

  app.get<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId", async (request) => {
    await loadOwnedSession(request, request.params.sessionId);
    const record = request.container.fileIndex.get(request.params.fileId, "session", request.params.sessionId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true, file: record };
  });

  app.delete<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId", async (request) => {
    await loadOwnedSession(request, request.params.sessionId);
    const record = request.container.fileIndex.delete(request.params.fileId, "session", request.params.sessionId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    await removeStoredFile(record, request.container.fileIndex.getSessionUploadsRoot(request.params.sessionId));
    return { success: true };
  });

  app.get<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId/download", async (request, reply) => {
    await loadOwnedSession(request, request.params.sessionId);
    const record = request.container.fileIndex.get(request.params.fileId, "session", request.params.sessionId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return sendFileDownload({
      record,
      expectedRoot: request.container.fileIndex.getSessionUploadsRoot(request.params.sessionId),
      reply,
    });
  });
};
