import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { SessionFileApplication } from "../../contracts/application/session-file-application.js";
import { ValidateFilesRequestSchema } from "../../contracts/storage/files.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import {
  collectMultipartFiles,
  sendBufferedFileDownload,
} from "../file-route-utils.js";
import { loadMutableSession, loadReadableSession } from "../session-owner.js";
import { resolveSessionApplication } from "../session-application.js";

interface SessionParams {
  sessionId: string;
}

interface SessionFileParams extends SessionParams {
  fileId: string;
}

export const registerSessionFileRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const loadReadable = async (request: Parameters<NonNullable<RouteOptions["resolveSessionApplication"]>>[0], sessionId: string) => {
    const sessions = await resolveSessionApplication(options, request);
    return loadReadableSession(request, sessionId, sessions);
  };

  const loadMutable = async (request: Parameters<NonNullable<RouteOptions["resolveSessionApplication"]>>[0], sessionId: string) => {
    const sessions = await resolveSessionApplication(options, request);
    return loadMutableSession(request, sessionId, sessions);
  };

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/files", async (request) => {
    await loadReadable(request, request.params.sessionId);
    const files = await resolveSessionFiles(options, request);
    return {
      success: true,
      files: await files.list(request.params.sessionId),
    };
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/files/validate", async (request) => {
    await loadReadable(request, request.params.sessionId);
    const payload = ValidateFilesRequestSchema.parse(request.body);
    const files = await resolveSessionFiles(options, request);
    return { success: true as const, ...await files.validate(request.params.sessionId, payload.file_ids) };
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/files/upload", async (request) => {
    await loadMutable(request, request.params.sessionId);
    const parts = await collectMultipartFiles(request);
    const sessionId = request.params.sessionId;
    const application = await resolveSessionFiles(options, request);
    const files = await Promise.all(parts.map((part) => application.add(sessionId, {
      originalName: part.filename,
      buffer: part.buffer,
      mime: part.mime,
    })));
    return { success: true, files };
  });

  app.get<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId", async (request) => {
    await loadReadable(request, request.params.sessionId);
    const files = await resolveSessionFiles(options, request);
    const record = await files.get(request.params.sessionId, request.params.fileId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true, file: record };
  });

  app.delete<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId", async (request) => {
    await loadMutable(request, request.params.sessionId);
    const files = await resolveSessionFiles(options, request);
    const record = await files.delete(request.params.sessionId, request.params.fileId);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true };
  });

  app.get<{ Params: SessionFileParams }>("/sessions/:sessionId/files/:fileId/download", async (request, reply) => {
    await loadReadable(request, request.params.sessionId);
    const files = await resolveSessionFiles(options, request);
    const source = await files.read(request.params.sessionId, request.params.fileId);
    if (source.status === "not_found") {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    if (source.status === "content_missing") {
      throw new HttpError(404, "not_found", "文件不存在于磁盘");
    }
    return sendBufferedFileDownload({
      body: source.body,
      filename: source.record.original_name,
      mime: source.contentType ?? source.record.mime,
      reply,
    });
  });
};

async function resolveSessionFiles(options: RouteOptions, request: FastifyRequest): Promise<SessionFileApplication> {
  const application = await options.resolveSessionFileApplication?.(request);
  if (!application) throw new Error("session file application resolver returned no implementation");
  return application;
}
