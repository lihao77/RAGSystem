import type { FastifyPluginAsync } from "fastify";

import { ValidateFilesRequestSchema } from "../../contracts/files.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import {
  collectMultipartFiles,
  removeStoredFile,
  sendBufferedFileDownload,
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

export const registerSessionFileRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const resolveAsyncStore = async (request: Parameters<NonNullable<RouteOptions["resolveSessionFileStorage"]>>[0]) =>
    options.resolveSessionFileStorage?.(request);

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/files", async (request) => {
    await loadOwnedSession(request, request.params.sessionId);
    const asyncStore = await resolveAsyncStore(request);
    return {
      success: true,
      files: asyncStore ? await asyncStore.list(request.params.sessionId) : request.container.fileIndex.list({
        scopeType: "session",
        scopeId: request.params.sessionId,
      }),
    };
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/files/validate", async (request) => {
    await loadOwnedSession(request, request.params.sessionId);
    const payload = ValidateFilesRequestSchema.parse(request.body);
    const asyncStore = await resolveAsyncStore(request);
    if (asyncStore) {
      const records = await Promise.all(payload.file_ids.map((id) => asyncStore.get(request.params.sessionId, id)));
      return {
        success: true as const,
        valid: payload.file_ids.filter((_id, index) => records[index] !== null),
        invalid: payload.file_ids.filter((_id, index) => records[index] === null),
      };
    }
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
    const asyncStore = await resolveAsyncStore(request);
    const files = asyncStore ? await Promise.all(parts.map((part) => asyncStore.add(sessionId, {
      originalName: part.filename,
      buffer: part.buffer,
      mime: part.mime,
    }))) : parts.map((part) =>
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
    const asyncStore = await resolveAsyncStore(request);
    const record = asyncStore
      ? await asyncStore.get(request.params.sessionId, request.params.fileId)
      : request.container.fileIndex.get(request.params.fileId, "session", request.params.sessionId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true, file: record };
  });

  app.delete<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId", async (request) => {
    await loadOwnedSession(request, request.params.sessionId);
    const asyncStore = await resolveAsyncStore(request);
    const record = asyncStore
      ? await asyncStore.delete(request.params.sessionId, request.params.fileId)
      : request.container.fileIndex.delete(request.params.fileId, "session", request.params.sessionId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    if (!asyncStore) await removeStoredFile(record, request.container.fileIndex.getSessionUploadsRoot(request.params.sessionId));
    return { success: true };
  });

  app.get<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId/download", async (request, reply) => {
    await loadOwnedSession(request, request.params.sessionId);
    const asyncStore = await resolveAsyncStore(request);
    const record = asyncStore
      ? await asyncStore.get(request.params.sessionId, request.params.fileId)
      : request.container.fileIndex.get(request.params.fileId, "session", request.params.sessionId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    if (asyncStore) {
      const source = await asyncStore.read(request.params.sessionId, request.params.fileId);
      if (!source) throw new HttpError(404, "not_found", "文件不存在");
      return sendBufferedFileDownload({ body: source.body, filename: record.original_name, mime: source.contentType ?? record.mime, reply });
    }
    return sendFileDownload({
      record,
      expectedRoot: request.container.fileIndex.getSessionUploadsRoot(request.params.sessionId),
      reply,
    });
  });
};
