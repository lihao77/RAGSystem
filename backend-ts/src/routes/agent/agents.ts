import type { FastifyPluginAsync } from "fastify";

import { CreateAgentRequestSchema } from "../../contracts/agent/agent-config.js";
import { ok } from "../../contracts/common.js";
import type { RouteOptions } from "../route-options.js";
import { HttpError } from "../../utils/errors.js";
import { ZodError } from "zod";
import { isRecord } from "../../utils/guards.js";
import { requireTenantAdmin, requireTenantMember } from "../tenant-role.js";

interface AgentParams {
  agentName: string;
}

export const registerAgentManagementRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/agents", async (request) => {
    const agents = request.container.agentConfig.listAgents().map(normalizeAgentCatalogItem).sort(sortAgentCatalogLikePython);
    return ok(agents, `共有 ${agents.length} 个智能体`);
  });

  app.post("/agents/create", async (request) => {
    requireTenantAdmin(request);
    const payload = parseCreateAgentRequest(request.body);
    try {
      const config = await request.container.agentConfig.createAgent(payload);
      return ok(config, `智能体 ${config.agent_name} 创建成功`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.delete<{ Params: AgentParams }>("/agents/delete/:agentName", async (request) => {
    requireTenantAdmin(request);
    try {
      const deleted = await request.container.agentConfig.deleteAgent(request.params.agentName);
      if (!deleted) {
        throw new HttpError(404, "not_found", `智能体 ${request.params.agentName} 不存在`);
      }
      return ok(undefined, `智能体 ${request.params.agentName} 已删除`);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(403, "forbidden", errorMessage(error));
    }
  });

  app.post("/agents/reload", async (request) => {
    requireTenantAdmin(request);
    return ok(
      {
        runtime: "ts",
        reloaded: true,
      },
      "智能体已重新加载",
    );
  });
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCreateAgentRequest(body: unknown) {
  try {
    return CreateAgentRequestSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError(
        422,
        "validation_error",
        "请求参数验证失败",
        error.issues.map((issue) => `body -> ${issue.path.join(" -> ") || "body"}: ${issue.message}`),
      );
    }
    throw error;
  }
}

function normalizeAgentCatalogItem(agent: unknown): Record<string, unknown> {
  const item = isRecord(agent) ? agent : {};
  const name = String(item.name ?? item.agent_name ?? "");
  return {
    name,
    description: item.description ?? null,
    capabilities: ["dynamic_planning", "agent_coordination", "adaptive_execution"],
    tools: normalizeAgentCatalogTools(name, item.tools),
    config: normalizeAgentCatalogConfig(item.config),
  };
}

const PYTHON_AGENT_ORDER = [
  "orchestrator_agent",
  "team_maker",
  "plan_agent",
  "explor_agent",
  "general_agent",
  "review_agent",
  "test_agent",
];

function sortAgentCatalogLikePython(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftName = String(left.name ?? "");
  const rightName = String(right.name ?? "");
  const leftIndex = PYTHON_AGENT_ORDER.indexOf(leftName);
  const rightIndex = PYTHON_AGENT_ORDER.indexOf(rightName);
  return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
    || leftName.localeCompare(rightName);
}

function normalizeAgentCatalogTools(agentName: string, value: unknown): string[] {
  const configured = Array.isArray(value) ? value.map(String) : [];
  const base = configured.length >= 3 ? configured : ["execute_bash", "preview_data_structure", "write_file", ...configured];
  if (agentName === "orchestrator_agent") {
    return [
      "execute_bash",
      "preview_data_structure",
      "write_file",
      "read_file",
      "edit_file",
      ...base,
    ].filter((item, index, array) => array.indexOf(item) === index);
  }
  return base.filter((item, index, array) => item && array.indexOf(item) === index);
}

function normalizeAgentCatalogConfig(config: unknown): Record<string, unknown> {
  const item = isRecord(config) ? config : {};
  return {
    enabled: item.enabled ?? true,
    llm_tiers: normalizeLlmTiers(item.llm_tiers),
    custom_params: item.custom_params ?? {},
  };
}

function normalizeLlmTiers(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, tier]) => [name, normalizeLlmTier(tier)]),
  );
}

function normalizeLlmTier(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const tier = { ...value };
  if (isRecord(tier.extra_params) && Object.keys(tier.extra_params).length === 0) {
    delete tier.extra_params;
  }
  return tier;
}
