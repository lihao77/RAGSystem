import type { FastifyPluginAsync } from "fastify";

import { GenericVectorRequestSchema, SearchVectorsRequestSchema } from "../contracts/vector-library.js";
import { ok } from "../contracts/common.js";
import { VectorLibraryServiceError } from "../services/knowledge/vector-library-service.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface CollectionParams {
  collectionName: string;
}

interface DocumentParams {
  collectionName: string;
  documentId: string;
}

export const registerVectorRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/collections", async () => {
    const data = options.container.vectorLibrary.listCollections();
    return {
      success: true,
      data,
      count: data.length,
    };
  });

  app.delete<{ Params: CollectionParams }>("/collections/:collectionName", async (request) => {
    try {
      return ok(options.container.vectorLibrary.deleteCollection(request.params.collectionName));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/search", async (request) => {
    const payload = SearchVectorsRequestSchema.parse(request.body);
    try {
      return ok(options.container.vectorLibrary.search(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/index", async (request) => {
    const payload = GenericVectorRequestSchema.parse(request.body ?? {});
    try {
      return ok(options.container.vectorLibrary.indexDocument(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: DocumentParams }>("/documents/:collectionName/:documentId", async (request) => {
    try {
      return ok(options.container.vectorLibrary.deleteDocument(
        request.params.collectionName,
        request.params.documentId,
      ));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: CollectionParams }>("/documents/:collectionName", async (request) => ({
    success: true,
    data: options.container.vectorLibrary.listDocuments(request.params.collectionName),
  }));

  app.get("/health", async () => ok(options.container.vectorLibrary.vectorHealth()));
};

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof VectorLibraryServiceError) {
    return new HttpError(error.statusCode, error.statusCode === 404 ? "not_found" : "invalid_request", error.message);
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}
