import type { FastifyPluginAsync } from "fastify";

import { SyncEmbeddingModelRequestSchema } from "../contracts/embedding-models.js";
import { EmbeddingModelServiceError } from "../services/knowledge/embedding-model-service.js";
import { VectorLibraryServiceError } from "../services/knowledge/vector-library-service.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface ModelParams {
  modelId: string;
}

interface DeleteQuery {
  force?: string | boolean;
}

interface StatsQuery {
  collection?: string;
}

interface SyncStatusQuery {
  collection?: string;
}

export const registerEmbeddingModelRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/models", async () => ({
    success: true,
    models: options.container.embeddingModels.listModels(),
  }));

  app.post<{ Params: ModelParams }>("/models/:modelId/activate", async (request) => {
    try {
      return {
        success: true,
        ...options.container.embeddingModels.activateModel(parseModelId(request.params.modelId), { missingOk: true }),
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: ModelParams; Querystring: DeleteQuery }>("/models/:modelId", async (request) => {
    try {
      return {
        success: true,
        ...options.container.embeddingModels.deleteModel(
          parseModelId(request.params.modelId),
          parseBoolean(request.query.force),
        ),
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ModelParams }>("/models/:modelId/sync", async (request) => {
    const modelId = parseModelId(request.params.modelId);
    const payload = SyncEmbeddingModelRequestSchema.parse(request.body ?? {});
    try {
      return {
        success: true,
        ...options.container.embeddingModels.syncModel(modelId, payload),
      };
    } catch (error) {
      if (error instanceof VectorLibraryServiceError && error.statusCode === 404 && error.message.startsWith("模型不存在:")) {
        throw new HttpError(500, "internal_error", error.message.replace("模型不存在: ", "模型不存在: ID="));
      }
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ModelParams; Querystring: StatsQuery }>("/models/:modelId/stats", async (request) => {
    void request.query.collection;
    return {
      success: true,
      stats: options.container.embeddingModels.getModelStats(parseModelId(request.params.modelId)),
    };
  });

  app.get<{ Querystring: SyncStatusQuery }>("/models/sync-status", async (request) => {
    const collection = request.query.collection?.trim() || "default";
    return {
      success: true,
      collection,
      sync_status: options.container.embeddingModels.getSyncStatus(collection),
    };
  });
};

function parseModelId(value: string): number {
  const modelId = Number(value);
  if (!Number.isInteger(modelId) || modelId <= 0) {
    throw new HttpError(400, "invalid_request", "model_id must be a positive integer");
  }
  return modelId;
}

function parseBoolean(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof EmbeddingModelServiceError) {
    if (error.statusCode === 404 && error.message.startsWith("模型不存在:")) {
      return new HttpError(500, "internal_error", error.message.replace("模型不存在: ", "模型不存在: ID="));
    }
    return new HttpError(error.statusCode, error.statusCode === 404 ? "not_found" : "invalid_request", error.message);
  }
  if (error instanceof VectorLibraryServiceError) {
    return new HttpError(error.statusCode, error.statusCode === 404 ? "not_found" : "invalid_request", error.message);
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}
