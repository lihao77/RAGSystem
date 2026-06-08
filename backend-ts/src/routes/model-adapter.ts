import type { FastifyPluginAsync } from "fastify";

import {
  ProviderPayloadSchema,
  ReorderProvidersRequestSchema,
  TestProviderRequestSchema,
} from "../contracts/model-adapter.js";
import { ok } from "../contracts/common.js";
import { ModelAdapterServiceError } from "../services/integrations/model-adapter-service.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface ProviderParams {
  providerKey: string;
}

export const registerModelAdapterRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/provider-types", async () => ok(options.container.modelAdapter.listProviderTypes(), "获取成功"));

  app.get("/providers", async () => {
    const providers = options.container.modelAdapter.listProviders();
    return {
      ...ok(providers, "Provider 列表获取成功"),
      providers,
    };
  });

  app.post("/providers", async (request) => {
    const payload = ProviderPayloadSchema.parse(request.body);
    try {
      const providerKey = options.container.modelAdapter.createProvider(payload);
      return {
        ...ok({ provider_key: providerKey }, "Provider 创建成功"),
        provider_key: providerKey,
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put("/providers/order", async (request) => {
    const payload = ReorderProvidersRequestSchema.parse(request.body);
    try {
      const providerKeys = options.container.modelAdapter.reorderProviders(payload);
      return {
        ...ok({ provider_keys: providerKeys }, "Provider 顺序更新成功"),
        provider_keys: providerKeys,
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put<{ Params: ProviderParams }>("/providers/:providerKey", async (request) => {
    const payload = ProviderPayloadSchema.parse(request.body);
    try {
      const providerKey = options.container.modelAdapter.updateProvider(request.params.providerKey, payload);
      return {
        ...ok({ provider_key: providerKey }, "Provider 更新成功"),
        provider_key: providerKey,
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: ProviderParams }>("/providers/:providerKey", async (request) => {
    try {
      options.container.modelAdapter.deleteProvider(request.params.providerKey);
      return ok(undefined, "Provider 删除成功");
    } catch (error) {
      if (error instanceof ModelAdapterServiceError && error.statusCode === 404 && error.message.startsWith("Provider 不存在:")) {
        throw new HttpError(500, "internal_error", `删除 Provider 失败: ${error.message}`);
      }
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ProviderParams }>("/providers/:providerKey/check", async (request) => {
    try {
      const result = options.container.modelAdapter.checkProviderAvailability(request.params.providerKey);
      return {
        ...ok(result, "检查成功"),
        ...result,
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/test", async (request) => {
    const payload = TestProviderRequestSchema.parse(request.body);
    try {
      const result = await options.container.modelAdapter.testProvider(payload);
      return {
        ...ok(result, "测试成功"),
        response: result,
      };
    } catch (error) {
      if (error instanceof ModelAdapterServiceError && error.statusCode === 404) {
        const result = {
          content: null,
          error: error.message,
          model: null,
          provider: String(payload.provider ?? ""),
          cost: null,
          latency: null,
          usage: null,
          finish_reason: null,
        };
        return {
          ...ok(result, "测试成功"),
          response: result,
        };
      }
      throw toHttpError(error);
    }
  });
};

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof ModelAdapterServiceError) {
    return new HttpError(error.statusCode, "invalid_request", error.message);
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}
