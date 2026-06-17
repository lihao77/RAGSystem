import type { FastifyPluginAsync } from "fastify";

import { ValidateFilesRequestSchema } from "../../contracts/files.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import {
  removeStoredFile,
  sendFileDownload,
  uploadMultipartFiles,
  validateFileIds,
} from "../file-route-utils.js";

interface SessionParams {
  sessionId: string;
}

interface SessionFileParams extends SessionParams {
  fileId: string;
}

export const registerSessionFileRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: SessionParams }>("/sessions/:sessionId/files", async (request) => ({
    success: true,
    files: options.container.fileIndex.list({
      scopeType: "session",
      scopeId: request.params.sessionId,
    }),
  }));

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/files/validate", async (request) => {
    const payload = ValidateFilesRequestSchema.parse(request.body);
    return validateFileIds({
      fileIndex: options.container.fileIndex,
      fileIds: payload.file_ids,
      scope: { scopeType: "session", scopeId: request.params.sessionId },
    });
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/files/upload", async (request) => ({
    success: true,
    files: await uploadMultipartFiles({
      request,
      fileIndex: options.container.fileIndex,
      scope: { scopeType: "session", scopeId: request.params.sessionId },
    }),
  }));

  app.get<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId", async (request) => {
    const record = options.container.fileIndex.get(request.params.fileId, "session", request.params.sessionId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true, file: record };
  });

  app.delete<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId", async (request) => {
    const record = options.container.fileIndex.delete(request.params.fileId, "session", request.params.sessionId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    await removeStoredFile(record, options.container.fileIndex.getSessionUploadsRoot(request.params.sessionId));
    return { success: true };
  });

  app.get<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId/download", async (request, reply) => {
    const record = options.container.fileIndex.get(request.params.fileId, "session", request.params.sessionId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return sendFileDownload({
      record,
      expectedRoot: options.container.fileIndex.getSessionUploadsRoot(request.params.sessionId),
      reply,
    });
  });
};
