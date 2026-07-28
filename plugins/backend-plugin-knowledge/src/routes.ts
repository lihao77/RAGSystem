import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type {} from "@ragsystem/backend-core/fastify-context.js";

import {
  GenericVectorRequestSchema,
  IndexFileRequestSchema,
  RerankerCreateSchema,
  SearchVectorsRequestSchema,
  UpdateChunkRequestSchema,
  UpdateMarkdownRequestSchema,
  VectorizerCreateSchema,
} from "./contracts/knowledge/knowledge-base.js";
import { ok } from "@ragsystem/backend-core/contracts/common.js";
import { KnowledgeBaseError } from "./contracts/knowledge/knowledge-base.js";
import type { KnowledgeFile } from "./contracts/vector-store/index.js";
import { HttpError, httpErrorFrom, statusHttpError } from "@ragsystem/backend-core/utils/errors.js";
import { matchesFileFilters } from "@ragsystem/backend-core/utils/file-filter.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import { collectMultipartFiles, parseCsvList, sendBufferedFileDownload } from "@ragsystem/backend-core/routes/file-route-utils.js";
import { requireTenantAdmin, requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";
import { KNOWLEDGE_APPLICATION_CAPABILITY } from "./capability.js";

interface CollectionParams {
  collectionName: string;
}

interface DocumentParams {
  collectionName: string;
  documentId: string;
}

interface FileParams { fileId: string; }
interface ChunkParams extends FileParams { chunkId: string; }
interface FileListQuery { extensions?: string; mime_types?: string; }
interface KeyParams { key: string; }
interface DocsQuery { collection?: string; }

export const registerKnowledgeBaseRoutes: FastifyPluginAsync = async (app) => {
  const resolveKnowledge = (request: FastifyRequest) =>
    request.container.pluginCapabilities.require(KNOWLEDGE_APPLICATION_CAPABILITY);
  app.addHook("preHandler", async (request) => {
    requireTenantMember(request);
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    const adminOperation = pathname.endsWith("/index-file")
      || (pathname.includes("/vectorizers") && request.method !== "GET")
      || pathname.endsWith("/migrate")
      || (pathname.includes("/rerankers") && request.method !== "GET")
      || (pathname.includes("/collections/") && request.method === "DELETE")
      || pathname.endsWith("/index")
      || (pathname.includes("/documents/") && request.method === "DELETE")
      || (pathname.includes("/files/") && request.method === "DELETE");
    if (adminOperation) requireTenantAdmin(request);
  });

  app.post("/files/upload", async (request) => {
    return { success: true, files: await (await resolveKnowledge(request)).upload(await collectMultipartFiles(request)) };
  });

  app.get<{ Querystring: FileListQuery }>("/files", async (request) => {
    const files = await (await resolveKnowledge(request)).listFiles();
    return { success: true, files: filterKnowledgeFiles(files, parseCsvList(request.query.extensions), parseCsvList(request.query.mime_types)) };
  });

  app.get<{ Params: FileParams }>("/files/:fileId", async (request) => {
    const file = await (await resolveKnowledge(request)).getFile(request.params.fileId);
    if (!file) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true, file };
  });

  app.get<{ Params: FileParams }>("/files/:fileId/md", async (request) => {
    const knowledge = await resolveKnowledge(request);
    const file = await knowledge.getFile(request.params.fileId);
    if (!file) throw new HttpError(404, "not_found", "文件不存在");
    if (!file.md_blob_hash) throw new HttpError(409, "markdown_not_ready", "文件尚未生成 Markdown，请先完成索引");
    try {
      return await knowledge.readMarkdown(file.id);
    } catch (error) {
      request.log.error({ err: error, file_id: file.id, md_blob_hash: file.md_blob_hash }, "读取知识库 Markdown 失败");
      throw new HttpError(500, "markdown_blob_missing", "Markdown 文件缺失或损坏");
    }
  });

  app.put<{ Params: FileParams }>("/files/:fileId/md", async (request) => {
    const payload = UpdateMarkdownRequestSchema.parse(request.body);
    try { return ok(await (await resolveKnowledge(request)).updateMarkdown(request.params.fileId, payload.content)); } catch (error) { throw toHttpError(error); }
  });

  app.get<{ Params: FileParams }>("/files/:fileId/chunks", async (request) => {
    try { return ok((await (await resolveKnowledge(request)).listChunks(request.params.fileId)).map((chunk) => ({ id: chunk.id, content: chunk.content, char_start: Number(chunk.metadata.char_start ?? 0), char_end: Number(chunk.metadata.char_end ?? 0), heading_path: String(chunk.metadata.heading_path ?? ""), chunk_index: chunk.chunk_index, manual: chunk.metadata.manual === true }))); } catch (error) { throw toHttpError(error); }
  });

  app.patch<{ Params: ChunkParams }>("/files/:fileId/chunks/:chunkId", async (request) => {
    const payload = UpdateChunkRequestSchema.parse(request.body);
    const chunkId = request.params.chunkId.trim();
    const numericId = /^[1-9]\d*$/.test(chunkId) && Number.isSafeInteger(Number(chunkId));
    const uuidId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chunkId);
    if (!numericId && !uuidId) {
      throw new HttpError(400, "invalid_chunk_id", "切片 ID 无效");
    }
    try { return ok(await (await resolveKnowledge(request)).updateChunk(request.params.fileId, chunkId, payload.content)); } catch (error) { throw toHttpError(error); }
  });

  app.delete<{ Params: FileParams }>("/files/:fileId", async (request) => {
    const result = await (await resolveKnowledge(request)).deleteFile(request.params.fileId);
    if (!result) {
      throw new HttpError(404, "not_found", "文件不存在");
    }
    return { success: true, deleted_chunks: result.deleted_chunks };
  });

  app.get<{ Params: FileParams }>("/files/:fileId/download", async (request, reply) => {
    const file = await (await resolveKnowledge(request)).download(request.params.fileId);
    if (!file) throw new HttpError(404, "not_found", "文件不存在");
    return sendBufferedFileDownload({ ...file, reply });
  });
  app.get("/file-status", async (request) => ok(await (await resolveKnowledge(request)).fileStatus()));

  app.post("/index-file", async (request) => {
    const payload = IndexFileRequestSchema.parse(request.body);
    try {
      return ok(await (await resolveKnowledge(request)).indexFile(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get("/vectorizers", async (request) => {
    return ok(await (await resolveKnowledge(request)).listVectorizers());
  });

  app.post("/vectorizers", async (request) => {
    const payload = VectorizerCreateSchema.parse(request.body);
    try {
      return ok(await (await resolveKnowledge(request)).addVectorizer(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: KeyParams }>("/vectorizers/:key/activate", async (request) => {
    try {
      return ok(await (await resolveKnowledge(request)).activateVectorizer(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: KeyParams; Querystring: DocsQuery }>("/vectorizers/:key/docs", async (request) => {
    void request.query.collection;
    try {
      return ok(await (await resolveKnowledge(request)).listDocsByVectorizer(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: KeyParams }>("/vectorizers/:key", async (request) => {
    try {
      return ok(await (await resolveKnowledge(request)).deleteVectorizer(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/migrate", async (request) => {
    const payload = GenericVectorRequestSchema.parse(request.body ?? {});
    try {
      return ok(await (await resolveKnowledge(request)).migrate(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get("/rerankers", async (request) => ok(await (await resolveKnowledge(request)).listRerankers()));

  app.post("/rerankers", async (request) => {
    const payload = RerankerCreateSchema.parse(request.body);
    try {
      return ok(await (await resolveKnowledge(request)).addReranker(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: KeyParams }>("/rerankers/:key", async (request) => {
    const reranker = await (await resolveKnowledge(request)).getReranker(request.params.key);
    if (!reranker) {
      throw new HttpError(404, "not_found", `重排序器不存在: ${request.params.key}`);
    }
    return ok(reranker);
  });

  app.post<{ Params: KeyParams }>("/rerankers/:key/activate", async (request) => {
    try {
      return ok(await (await resolveKnowledge(request)).activateReranker(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: KeyParams }>("/rerankers/:key", async (request) => {
    try {
      return ok(await (await resolveKnowledge(request)).deleteReranker(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });
  app.get("/collections", async (request) => {
    const data = await (await resolveKnowledge(request)).listCollections();
    return {
      success: true,
      data,
      count: Array.isArray(data) ? data.length : 0,
    };
  });

  app.delete<{ Params: CollectionParams }>("/collections/:collectionName", async (request) => {
    try {
      const result = await (await resolveKnowledge(request)).deleteCollection(request.params.collectionName);
      return {
        success: true,
        data: result,
        message: String(result.message ?? `集合 ${request.params.collectionName} 已删除`),
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/search", async (request) => {
    const payload = SearchVectorsRequestSchema.parse(request.body);
    try {
      return ok(await (await resolveKnowledge(request)).search(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/index", async (request) => {
    const payload = GenericVectorRequestSchema.parse(request.body ?? {});
    try {
      return ok(await (await resolveKnowledge(request)).indexDocument(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: DocumentParams }>("/documents/:collectionName/:documentId", async (request) => {
    try {
      const result = await (await resolveKnowledge(request)).deleteDocument(
        request.params.collectionName,
        request.params.documentId,
      );
      return {
        success: true,
        data: result,
        message: String(result.message ?? `文档 ${request.params.documentId} 已从集合 ${request.params.collectionName} 中删除`),
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: CollectionParams }>("/documents/:collectionName", async (request) => {
    const data = await (await resolveKnowledge(request)).listDocuments(request.params.collectionName);
    return {
      success: true,
      data: normalizeDocumentsResponse(data),
    };
  });

  app.get("/health", async (request) => ok(normalizeVectorHealth(await (await resolveKnowledge(request)).vectorHealth())));
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

function toHttpError(error: unknown): HttpError {
  return httpErrorFrom(error, (e) => {
    if (!(e instanceof KnowledgeBaseError)) return null;
    return statusHttpError(e.statusCode, e.message);
  });
}

function normalizeDocumentsResponse(data: Record<string, unknown>): Record<string, unknown> {
  const info = isRecord(data.info) ? data.info : {};
  const normalizedInfo = Object.keys(info).length === 0 || Number(data.total_chunks ?? 0) === 0
    ? {}
    : info;
  return {
    ...data,
    info: normalizedInfo,
  };
}

function normalizeVectorHealth(data: Record<string, unknown>): Record<string, unknown> {
  return {
    status: data.status ?? "healthy",
    collections_count: data.collections_count ?? 0,
  };
}
