import type { FastifyPluginAsync } from "fastify";

import {
  DeleteIndexedFileRequestSchema,
  GenericVectorRequestSchema,
  IndexFileRequestSchema,
  RerankerCreateSchema,
  VectorizerCreateSchema,
} from "../contracts/vector-library.js";
import { ok } from "../contracts/common.js";
import { VectorLibraryServiceError } from "../contracts/vector-library.js";
import { HttpError, httpErrorFrom } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface KeyParams {
  key: string;
}

interface DocsQuery {
  collection?: string;
}

export const registerVectorLibraryRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/file-status", async () => ok(await options.container.vectorLibrary.fileStatus()));

  app.post("/index-file", async (request) => {
    const payload = IndexFileRequestSchema.parse(request.body);
    try {
      return ok(await options.container.vectorLibrary.indexFile(payload));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/delete-file", async (request) => {
    const payload = DeleteIndexedFileRequestSchema.parse(request.body);
    try {
      const result = await options.container.vectorLibrary.deleteIndexedFile(payload);
      if (Number(result.deleted_chunks ?? 0) <= 0) {
        throw new HttpError(404, "not_found", "未找到该文件对应的分块");
      }
      return ok(result);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get("/vectorizers", async () => ok(await options.container.vectorLibrary.listVectorizers()));

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
      return ok(await options.container.vectorLibrary.listDocsByVectorizer(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: KeyParams }>("/vectorizers/:key", async (request) => {
    try {
      return ok(await options.container.vectorLibrary.deleteVectorizer(request.params.key));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/migrate", async (request) => {
    const payload = GenericVectorRequestSchema.parse(request.body ?? {});
    try {
      return ok(await options.container.vectorLibrary.migrate(payload));
    } catch (error) {
      throw toHttpError(error);
    }
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
  return httpErrorFrom(error, (e) => {
    if (!(e instanceof VectorLibraryServiceError)) {
      return null;
    }
    if (
      e.message.startsWith("重排序器不存在:") ||
      e.message === "model 模式的重排序器必须提供 provider_key 和 model_name"
    ) {
      return new HttpError(500, "internal_error", e.message);
    }
    return new HttpError(e.statusCode, "invalid_request", e.message);
  });
}
