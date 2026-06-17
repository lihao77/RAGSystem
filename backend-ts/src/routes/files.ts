import type { FastifyPluginAsync } from "fastify";

import { ValidateFilesRequestSchema } from "../contracts/files.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import {
  parseCsvList,
  removeStoredFile,
  sendFileDownload,
  uploadMultipartFiles,
  validateFileIds,
} from "./file-route-utils.js";

interface FileParams {
  fileId: string;
}

interface FileListQuery {
  extensions?: string;
  mime_types?: string;
}

export const registerFileRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Querystring: FileListQuery }>("/", async (request) => ({
    success: true,
    files: options.container.fileIndex.list({
      scopeType: "global",
      scopeId: null,
      extensions: parseCsvList(request.query.extensions),
      mimeTypes: parseCsvList(request.query.mime_types),
    }),
  }));

  app.get("/validate", async (request) => {
    if (request.body === undefined || request.body === null) {
      throw new HttpError(400, "invalid_request", "missing body");
    }
    const payload = ValidateFilesRequestSchema.parse(request.body);
    return validateFileIds({
      fileIndex: options.container.fileIndex,
      fileIds: payload.file_ids,
      scope: { scopeType: "global", scopeId: null },
    });
  });

  app.post("/validate", async (request) => {
    const payload = ValidateFilesRequestSchema.parse(request.body);
    return validateFileIds({
      fileIndex: options.container.fileIndex,
      fileIds: payload.file_ids,
      scope: { scopeType: "global", scopeId: null },
    });
  });

  app.post("/upload", async (request) => ({
    success: true,
    files: await uploadMultipartFiles({
      request,
      fileIndex: options.container.fileIndex,
      scope: { scopeType: "global", scopeId: null },
    }),
  }));

  app.get<{ Params: FileParams }>("/:fileId", async (request) => {
    if (request.params.fileId === "validate") {
      throw new HttpError(404, "not_found", "Not found");
    }
    const record = options.container.fileIndex.get(request.params.fileId, "global", null);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true, file: record };
  });

  app.delete<{ Params: FileParams }>("/:fileId", async (request) => {
    const record = options.container.fileIndex.delete(request.params.fileId, "global", null);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    await removeStoredFile(record, options.container.fileIndex.getGlobalUploadsRoot());
    return { success: true };
  });

  app.get<{ Params: FileParams }>("/:fileId/download", async (request, reply) => {
    const record = options.container.fileIndex.get(request.params.fileId, "global", null);
    if (!record) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return sendFileDownload({
      record,
      expectedRoot: options.container.fileIndex.getGlobalUploadsRoot(),
      reply,
    });
  });
};
