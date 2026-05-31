import type { FastifyPluginAsync } from "fastify";

import {
  DeleteIndexedFileRequestSchema,
  GenericVectorRequestSchema,
  IndexFileRequestSchema,
  RerankerCreateSchema,
  VectorizerCreateSchema,
} from "../contracts/vector-library.js";
import { ok } from "../contracts/common.js";
import { VectorLibraryServiceError } from "../services/vector-library-service.js";
import { HttpError, NotMigratedError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface KeyParams {
  key: string;
}

interface DocsQuery {
  collection?: string;
}

export const registerVectorLibraryRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/file-status", async () => ok(options.container.vectorLibrary.fileStatus()));

  app.post("/index-file", async (request) => {
    IndexFileRequestSchema.parse(request.body);
    throw new NotMigratedError("Vector file indexing");
  });

  app.post("/delete-file", async (request) => {
    DeleteIndexedFileRequestSchema.parse(request.body);
    throw new NotMigratedError("Vector indexed file deletion");
  });

  app.get("/vectorizers", async () => ok(options.container.vectorLibrary.listVectorizers()));

  app.post("/vectorizers", async (request) => {
    const payload = VectorizerCreateSchema.parse(request.body);
    try {
      return ok(options.container.vectorLibrary.addVectorizer(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: KeyParams }>("/vectorizers/:key/activate", async (request) => {
    try {
      return ok(options.container.vectorLibrary.activateVectorizer(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: KeyParams; Querystring: DocsQuery }>("/vectorizers/:key/docs", async (request) => {
    void request.query.collection;
    try {
      return ok(options.container.vectorLibrary.listDocsByVectorizer(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: KeyParams }>("/vectorizers/:key", async (request) => {
    try {
      return ok(options.container.vectorLibrary.deleteVectorizer(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/migrate", async (request) => {
    GenericVectorRequestSchema.parse(request.body ?? {});
    throw new NotMigratedError("Vector data migration");
  });

  app.get("/rerankers", async () => ok(options.container.vectorLibrary.listRerankers()));

  app.post("/rerankers", async (request) => {
    const payload = RerankerCreateSchema.parse(request.body);
    try {
      return ok(options.container.vectorLibrary.addReranker(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: KeyParams }>("/rerankers/:key", async (request) => {
    const reranker = options.container.vectorLibrary.getReranker(request.params.key);
    if (!reranker) {
      throw new HttpError(404, "not_found", `重排序器不存在: ${request.params.key}`);
    }
    return ok(reranker);
  });

  app.post<{ Params: KeyParams }>("/rerankers/:key/activate", async (request) => {
    try {
      return ok(options.container.vectorLibrary.activateReranker(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: KeyParams }>("/rerankers/:key", async (request) => {
    try {
      return ok(options.container.vectorLibrary.deleteReranker(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });
};

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof VectorLibraryServiceError) {
    return new HttpError(error.statusCode, "invalid_request", error.message);
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}
