import type { FastifyPluginAsync } from "fastify";

import { SyncEmbeddingModelRequestSchema } from "../contracts/knowledge/embedding-models.js";
import { EmbeddingModelServiceError } from "../services/knowledge/embedding-model-service.js";
import { KnowledgeBaseError } from "../contracts/knowledge/knowledge-base.js";
import { HttpError, httpErrorFrom, statusHttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { requireTenantAdmin, requireTenantMember } from "./tenant-role.js";

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
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/models", async (request) => ({
    success: true,
    models: await request.container.embeddingModels.listModels(),
  }));

  app.post<{ Params: ModelParams }>("/models/:modelId/activate", async (request) => {
    requireTenantAdmin(request);
    try {
      return {
        success: true,
        ...(await request.container.embeddingModels.activateModel(parseModelId(request.params.modelId), { missingOk: true })),
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: ModelParams; Querystring: DeleteQuery }>("/models/:modelId", async (request) => {
    requireTenantAdmin(request);
    try {
      return {
        success: true,
        ...(await request.container.embeddingModels.deleteModel(
          parseModelId(request.params.modelId),
          parseBoolean(request.query.force),
        )),
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ModelParams }>("/models/:modelId/sync", async (request) => {
    requireTenantAdmin(request);
    const modelId = parseModelId(request.params.modelId);
    const payload = SyncEmbeddingModelRequestSchema.parse(request.body ?? {});
    try {
      return {
        success: true,
        ...(await request.container.embeddingModels.syncModel(modelId, payload)),
      };
    } catch (error) {
      if (error instanceof KnowledgeBaseError && error.statusCode === 404 && error.message.startsWith("模型不存在:")) {
        throw new HttpError(500, "internal_error", error.message.replace("模型不存在: ", "模型不存在: ID="));
      }
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ModelParams; Querystring: StatsQuery }>("/models/:modelId/stats", async (request) => {
    void request.query.collection;
    return {
      success: true,
      stats: await request.container.embeddingModels.getModelStats(parseModelId(request.params.modelId)),
    };
  });

  app.get<{ Querystring: SyncStatusQuery }>("/models/sync-status", async (request) => {
    const collection = request.query.collection?.trim() || "default";
    return {
      success: true,
      collection,
      sync_status: await request.container.embeddingModels.getSyncStatus(collection),
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
  return httpErrorFrom(error, (e) => {
    if (e instanceof EmbeddingModelServiceError) {
      if (e.statusCode === 404 && e.message.startsWith("模型不存在:")) {
        return new HttpError(500, "internal_error", e.message.replace("模型不存在: ", "模型不存在: ID="));
      }
      return statusHttpError(e.statusCode, e.message);
    }
    if (e instanceof KnowledgeBaseError) {
      return statusHttpError(e.statusCode, e.message);
    }
    return null;
  });
}
