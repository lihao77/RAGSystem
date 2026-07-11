import type { FastifyPluginAsync } from "fastify";

import { GenericVectorRequestSchema, SearchVectorsRequestSchema } from "../contracts/vector-library.js";
import { ok } from "../contracts/common.js";
import { VectorLibraryServiceError } from "../contracts/vector-library.js";
import { HttpError, httpErrorFrom, statusHttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { isRecord } from "../utils/guards.js";

interface CollectionParams {
  collectionName: string;
}

interface DocumentParams {
  collectionName: string;
  documentId: string;
}

export const registerVectorRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/collections", async () => {
    const data = await options.container.vectorLibrary.listCollections();
    return {
      success: true,
      data,
      count: data.length,
    };
  });

  app.delete<{ Params: CollectionParams }>("/collections/:collectionName", async (request) => {
    try {
      const result = await options.container.vectorLibrary.deleteCollection(request.params.collectionName);
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
      return ok(await options.container.vectorLibrary.search(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/index", async (request) => {
    const payload = GenericVectorRequestSchema.parse(request.body ?? {});
    try {
      return ok(await options.container.vectorLibrary.indexDocument(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: DocumentParams }>("/documents/:collectionName/:documentId", async (request) => {
    try {
      const result = await options.container.vectorLibrary.deleteDocument(
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
    const data = await options.container.vectorLibrary.listDocuments(request.params.collectionName);
    return {
      success: true,
      data: normalizeDocumentsResponse(data),
    };
  });

  app.get("/health", async () => ok(normalizeVectorHealth(await options.container.vectorLibrary.vectorHealth())));
};

function toHttpError(error: unknown): HttpError {
  return httpErrorFrom(error, (e) =>
    e instanceof VectorLibraryServiceError ? statusHttpError(e.statusCode, e.message) : null,
  );
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
