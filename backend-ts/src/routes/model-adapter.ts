import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import {
  ProviderPayloadSchema,
  ReorderProvidersRequestSchema,
  TestProviderRequestSchema,
} from "../contracts/integrations/model-adapter.js";
import { ok } from "../contracts/common.js";
import { ModelAdapterServiceError } from "../services/integrations/model-adapter-service.js";
import { HttpError, httpErrorFrom } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { requireTenantAdmin, requireTenantMember } from "./tenant-role.js";
import { ensureRequestApplications } from "../app/request-applications.js";

interface ProviderParams {
  providerKey: string;
}

export const registerModelAdapterRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => {
    requireTenantMember(request);
    if (request.method !== "GET") requireTenantAdmin(request);
  });

  app.get("/provider-types", async (request) => ok(await (await ensureRequestApplications(request, options)).providers.listProviderTypes(), "获取成功"));

  app.get("/providers", async (request) => {
    const providers = (await (await ensureRequestApplications(request, options)).providers.listProviders())
      .map(redactProviderSecrets);
    return {
      ...ok(providers, "Provider 列表获取成功"),
      providers,
    };
  });

  app.post("/providers", async (request) => {
    const payload = ProviderPayloadSchema.parse(request.body);
    try {
      const providerKey = await (await ensureRequestApplications(request, options)).providers.createProvider(payload);
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
      const providerKeys = await (await ensureRequestApplications(request, options)).providers.reorderProviders(payload.provider_keys);
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
      const providerKey = await (await ensureRequestApplications(request, options)).providers.updateProvider(request.params.providerKey, payload);
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
      const usages = await collectProviderUsages(request, options, request.params.providerKey);
      if (usages.length > 0) {
        throw new HttpError(
          409,
          "provider_in_use",
          `Provider 仍被 ${usages.length} 个配置引用，请先解除引用`,
          usages.map((usage) => `${usage.kind}:${usage.label}`),
        );
      }
      await (await ensureRequestApplications(request, options)).providers.deleteProvider(request.params.providerKey);
      return ok(undefined, "Provider 删除成功");
    } catch (error) {
      if (error instanceof ModelAdapterServiceError && error.statusCode === 404 && error.message.startsWith("Provider 不存在:")) {
        throw new HttpError(500, "internal_error", `删除 Provider 失败: ${error.message}`);
      }
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ProviderParams }>("/providers/:providerKey/usages", async (request) => {
    const usages = await collectProviderUsages(request, options, request.params.providerKey);
    return {
      ...ok({ provider_key: request.params.providerKey, usages }, "获取成功"),
      provider_key: request.params.providerKey,
      usages,
    };
  });

  app.get<{ Params: ProviderParams }>("/providers/:providerKey/check", async (request) => {
    try {
      const result = await (await ensureRequestApplications(request, options)).providers.checkProviderAvailability(request.params.providerKey);
      return {
        ...ok(result, "检查成功"),
        ...result,
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ProviderParams }>("/providers/:providerKey/metrics", async (request) => {
    try {
      return ok(await (await ensureRequestApplications(request, options)).providers.getProviderMetrics(request.params.providerKey), "获取成功");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post("/test", async (request) => {
    const payload = TestProviderRequestSchema.parse(request.body);
    try {
      const result = await (await ensureRequestApplications(request, options)).providers.testProvider(payload);
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

function redactProviderSecrets<T extends Record<string, unknown>>(provider: T): Omit<T, "api_key"> & { api_key_configured: boolean } {
  const { api_key: apiKey, ...visible } = provider;
  return {
    ...visible,
    api_key_configured: Boolean(String(apiKey ?? "").trim()),
  };
}

interface ProviderUsage {
  kind: "agent" | "vectorizer" | "reranker";
  key: string;
  label: string;
  detail: string;
}

async function collectProviderUsages(
  request: FastifyRequest,
  options: RouteOptions,
  providerKey: string,
): Promise<ProviderUsage[]> {
  const applications = await ensureRequestApplications(request, options);
  const providers = await applications.providers.listProviders();
  const provider = providers.find((item) => item.key === providerKey);
  if (!provider) {
    throw new HttpError(404, "not_found", `Provider 不存在: ${providerKey}`);
  }
  const aliases = new Set([providerKey, provider.name].map(normalizeProviderRef).filter(Boolean));
  const usages: ProviderUsage[] = [];

  for (const agent of request.container.agentConfig.listAgents()) {
    for (const [tierName, tier] of Object.entries(agent.config.llm_tiers ?? {})) {
      if (!aliases.has(normalizeProviderRef(tier.provider))) continue;
      usages.push({
        kind: "agent",
        key: agent.agent_name,
        label: agent.display_name || agent.agent_name,
        detail: `${tierName} 模型档位`,
      });
    }
  }

  const knowledge = await options.resolveKnowledgeApplication?.(request);
  if (knowledge) {
    const [vectorizers, rerankers] = await Promise.all([
      knowledge.listVectorizers(),
      knowledge.listRerankers(),
    ]);
    for (const vectorizer of vectorizers) {
      if (!aliases.has(normalizeProviderRef(vectorizer.provider_key))) continue;
      usages.push({
        kind: "vectorizer",
        key: vectorizer.vectorizer_key,
        label: vectorizer.vectorizer_key,
        detail: vectorizer.model_name,
      });
    }
    for (const reranker of rerankers) {
      if (reranker.mode !== "model" || !aliases.has(normalizeProviderRef(reranker.provider_key))) continue;
      usages.push({
        kind: "reranker",
        key: reranker.reranker_key,
        label: reranker.reranker_key,
        detail: reranker.model_name,
      });
    }
  }

  return usages;
}

function normalizeProviderRef(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function toHttpError(error: unknown): HttpError {
  return httpErrorFrom(error, (e) =>
    e instanceof ModelAdapterServiceError ? new HttpError(e.statusCode, "invalid_request", e.message) : null,
  );
}
