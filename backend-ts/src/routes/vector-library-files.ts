import type { FastifyPluginAsync } from "fastify";

import type { KnowledgeFile } from "../contracts/vector-store/index.js";
import { HttpError } from "../utils/errors.js";
import { matchesFileFilters } from "../utils/file-filter.js";
import type { RouteOptions } from "./route-options.js";
import { collectMultipartFiles, parseCsvList, sendFileDownload } from "./file-route-utils.js";

interface FileParams {
  fileId: string;
}

interface FileListQuery {
  extensions?: string;
  mime_types?: string;
}

/**
 * 知识库文件 HTTP 端点(归知识库命名空间,不再混用通用 /api/files)。
 * 文件元数据 + 物理 blob 全部走 driver(IKnowledgeFileStore,knowledge.db.kb_files),
 * 不写主库 uploaded_files(后者只留会话附件 session scope)。
 */
export const registerVectorLibraryFileRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const vectorLibrary = options.container.vectorLibrary;
  const store = vectorLibrary.knowledgeFileStore;

  app.post("/files/upload", async (request) => {
    const parts = await collectMultipartFiles(request);
    const files = parts.map((part) =>
      store.addKnowledgeFile({ originalName: part.filename, buffer: part.buffer, mime: part.mime }),
    );
    return { success: true, files };
  });

  app.get<{ Querystring: FileListQuery }>("/files", async (request) => ({
    success: true,
    files: filterKnowledgeFiles(
      store.listKnowledgeFiles(),
      parseCsvList(request.query.extensions),
      parseCsvList(request.query.mime_types),
    ),
  }));

  app.get<{ Params: FileParams }>("/files/:fileId", async (request) => {
    const file = store.getKnowledgeFile(request.params.fileId);
    if (!file) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true, file };
  });

  app.delete<{ Params: FileParams }>("/files/:fileId", async (request) => {
    const result = await vectorLibrary.deleteKnowledgeFileWithVectors(request.params.fileId);
    if (!result) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true, deleted_chunks: result.deleted_chunks };
  });

  app.get<{ Params: FileParams }>("/files/:fileId/download", async (request, reply) => {
    const file = store.getKnowledgeFile(request.params.fileId);
    if (!file) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return sendFileDownload({ record: file, expectedRoot: store.getKnowledgeUploadsRoot(), reply });
  });
};

function filterKnowledgeFiles(
  files: KnowledgeFile[],
  extensions: string[],
  mimeTypes: string[],
): KnowledgeFile[] {
  if (!extensions.length && !mimeTypes.length) {
    return files;
  }
  return files.filter((file) => matchesFileFilters(file.original_name, file.mime, extensions, mimeTypes));
}
