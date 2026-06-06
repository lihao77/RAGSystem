import type { FastifyPluginAsync } from "fastify";

import type { AgentConfig } from "../../contracts/agent-config.js";
import { ok } from "../../contracts/common.js";
import type { ModelProviderConfig } from "../../contracts/model-adapter.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";

interface ContextSnapshotQuery {
  session_id?: string;
  selected_llm?: string;
}

export const registerMonitoringRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/metrics", async (request) => {
    const query = request.query as { agent_name?: string };
    if (query.agent_name?.trim()) {
      throw new HttpError(404, "not_found", `未找到智能体 ${query.agent_name.trim()} 的指标`);
    }
    return ok(emptySystemMetrics(), "获取系统指标成功");
  });

  app.post("/metrics/reset", async (request) => {
    const body = isRecord(request.body) ? request.body : {};
    const agentName = typeof body.agent_name === "string" && body.agent_name.trim() ? body.agent_name.trim() : "";
    return ok(undefined, `已重置${agentName ? `智能体 ${agentName}` : "所有"}指标`);
  });

  app.get("/context-snapshot", async (request) => {
    const query = request.query as ContextSnapshotQuery;
    const sessionId = normalizeString(query.session_id);
    const sessionMetadata = sessionId ? options.container.conversationStore.getSession(sessionId)?.metadata ?? {} : {};
    const resolved = options.container.runtimeCore.resolveExecutionConfig({
      agentName: normalizeSessionEntryAgent(sessionMetadata.entry_agent),
      teamName: normalizeString(sessionMetadata.team),
      selectedLlm: normalizeString(query.selected_llm),
    });
    if (!resolved.agent) {
      throw new HttpError(503, "runtime_not_ready", "默认入口智能体未加载");
    }

    const agent = applySessionAgentOverrides(resolved.agent, sessionMetadata);
    const systemPrompt = getSystemPrompt(agent);
    const context = sessionId
      ? options.container.agentRuntimeContextBuilder.buildContext({
          sessionId,
          agent,
          historyLimit: 500,
        })
      : null;
    const memorySnapshot = getMemorySnapshot(context?.metadata.sources ?? []);
    const history = sessionId
      ? options.container.conversationStore.listMessages(sessionId, 500, 0).items.map(toContextHistoryItem)
      : [];
    const systemPromptTokens = estimateTokens(systemPrompt) + estimateTokens(asString(memorySnapshot?.rendered_block) ?? "");
    const historyTokens = history.reduce((total, item) => total + item.tokens, 0);
    const budgetTokens = resolveContextBudget(agent, resolved.provider);

    const data = {
      system_prompt: systemPrompt,
      available_agent_tools: buildAvailableAgentTools(agent, normalizeString(sessionMetadata.team), options),
      conversation_history: history,
      token_stats: {
        system_prompt_tokens: systemPromptTokens,
        history_tokens: historyTokens,
        total_tokens: systemPromptTokens + historyTokens,
        budget_tokens: budgetTokens,
      },
      config: {
        agent_name: agent.agent_name,
        display_name: agent.display_name ?? agent.agent_name,
        compression: buildCompressionConfig(agent),
        model: resolved.modelName ?? agent.llm_tiers?.default?.model_name ?? "",
        ...(query.selected_llm ? { llm_override: parseSelectedLlmForSnapshot(query.selected_llm) } : {}),
        runtime: {
          provider_ready: resolved.readiness.configuration_ready,
          execution_runtime: "ts",
          context_snapshot: "ts_compat",
        },
      },
      available_tools: options.container.runtimeToolBridge
        .listVisibleTools(agent)
        .map((tool) => ({ name: tool.name, description: tool.description })),
      available_skills: buildAvailableSkills(agent, options),
      ...(memorySnapshot
        ? {
            memory: {
              indices: getRecord(memorySnapshot.indices),
              scope_capabilities: getRecord(memorySnapshot.scope_capabilities),
              rendered_block: asString(memorySnapshot.rendered_block) ?? "",
            },
          }
        : {}),
    };
    return ok(data, "获取上下文快照成功");
  });

  app.get("/context-snapshot/message-content", async (request) => {
    const query = request.query as { session_id?: string; seq?: string };
    const sessionId = query.session_id?.trim();
    const seq = Number.parseInt(query.seq ?? "", 10);
    if (!sessionId || !Number.isInteger(seq) || seq < 1) {
      throw new HttpError(400, "invalid_request", "请提供有效的 session_id 和 seq");
    }

    const message = options.container.conversationStore.getMessageBySeq(sessionId, seq);
    if (!message) {
      throw new HttpError(404, "not_found", "消息不存在");
    }

    return ok(
      {
        id: message.id,
        seq: message.seq,
        role: message.role,
        content: message.content,
        content_length: message.content.length,
      },
      "获取消息完整内容成功",
    );
  });

  app.get("/tool-call/raw-result", async (request) => {
    const query = request.query as { session_id?: string; call_id?: string };
    const sessionId = query.session_id?.trim();
    const callId = query.call_id?.trim();
    if (!sessionId || !callId) {
      throw new HttpError(400, "invalid_request", "请提供 session_id 和 call_id");
    }

    const item = options.container.conversationStore.getToolCallRawResult(sessionId, callId);
    if (!item) {
      throw new HttpError(404, "not_found", "未找到对应的工具调用原始结果");
    }

    return ok(item, "获取工具调用原始结果成功");
  });
};

function emptySystemMetrics(): {
  total_agents: number;
  total_calls: number;
  avg_duration_ms: number;
  overall_success_rate: number;
  waiting: {
    total_waits: number;
    total_completed: number;
    total_timeouts: number;
    total_keepalive_rounds: number;
  };
  agents: Record<string, never>;
} {
  return {
    total_agents: 0,
    total_calls: 0,
    avg_duration_ms: 0,
    overall_success_rate: 0,
    waiting: {
      total_waits: 0,
      total_completed: 0,
      total_timeouts: 0,
      total_keepalive_rounds: 0,
    },
    agents: {},
  };
}

function toContextHistoryItem(message: {
  seq: number;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
}): {
  seq: number;
  role: string;
  content_preview: string;
  content_length: number;
  is_preview_truncated: boolean;
  can_load_full_content: boolean;
  tokens: number;
  is_compression_summary: boolean;
  react_intermediate: boolean;
  msg_type: string | null;
  round: number | null;
} {
  const isSystemMessage = message.role === "system";
  const truncated = !isSystemMessage && message.content.length > 200;
  return {
    seq: message.seq,
    role: message.role,
    content_preview: truncated ? `${message.content.slice(0, 200)}...` : message.content,
    content_length: message.content.length,
    is_preview_truncated: truncated,
    can_load_full_content: !isSystemMessage && message.seq != null,
    tokens: estimateTokens(message.content),
    is_compression_summary: Boolean(message.metadata.compression),
    react_intermediate: Boolean(message.metadata.react_intermediate),
    msg_type: normalizeString(message.metadata.msg_type),
    round: typeof message.metadata.round === "number" ? message.metadata.round : null,
  };
}

function getSystemPrompt(agent: AgentConfig): string {
  const behavior = agent.custom_params.behavior;
  if (!isRecord(behavior)) {
    return "";
  }
  return normalizeString(behavior.system_prompt) ?? "";
}

function buildCompressionConfig(agent: AgentConfig): Record<string, unknown> {
  const behavior = isRecord(agent.custom_params.behavior) ? agent.custom_params.behavior : {};
  return {
    strategy: "llm_summarize",
    trigger_ratio: numberOrDefault(behavior.compression_trigger_ratio, 0.85),
    preserve_recent_turns: numberOrDefault(behavior.preserve_recent_turns, 3),
    summarize_max_tokens: numberOrDefault(behavior.summarize_max_tokens, 300),
  };
}

function buildAvailableAgentTools(
  agent: AgentConfig,
  teamName: string | null,
  options: RouteOptions,
): Array<Record<string, unknown>> {
  return (agent.delegation.enabled_agents ?? []).map((agentName) => {
    const config = options.container.agentConfig.getConfig(agentName, { teamName });
    if (!config) {
      return {
        name: agentName,
        agent_name: agentName,
        description: null,
      };
    }
    return {
      name: config.agent_name,
      agent_name: config.agent_name,
      display_name: config.display_name ?? config.agent_name,
      description: config.description ?? null,
    };
  });
}

function buildAvailableSkills(agent: AgentConfig, options: RouteOptions): Array<Record<string, unknown>> {
  const available = options.container.agentConfig.listAvailableSkills();
  const byName = new Map<string, Record<string, unknown>>();
  for (const item of available) {
    if (isRecord(item)) {
      const name = normalizeString(item.name);
      if (name) {
        byName.set(name, item);
      }
    }
  }
  return (agent.skills.enabled_skills ?? []).map((name) => ({
    name,
    description: normalizeString(byName.get(name)?.description) ?? "",
    ...(byName.get(name) ?? {}),
  }));
}

function getMemorySnapshot(sources: Array<{ name: string; metadata?: Record<string, unknown> }>): Record<string, unknown> | null {
  for (const source of sources) {
    if (source.name !== "memory") {
      continue;
    }
    const snapshot = source.metadata?.snapshot;
    return isRecord(snapshot) ? snapshot : null;
  }
  return null;
}

function resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig | null): number {
  return positiveInt(provider?.max_context_tokens)
    ?? positiveInt(agent.llm_tiers?.default?.max_context_tokens)
    ?? 128000;
}

function parseSelectedLlmForSnapshot(value: string): Record<string, string | null> {
  const parts = value.split("|").map((part) => part.trim());
  return {
    provider: parts[0] || null,
    provider_type: parts[1] || null,
    model_name: parts[2] || null,
  };
}

function normalizeSessionEntryAgent(value: unknown): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === "default") {
    return null;
  }
  if (lowered === "orchestrator") {
    return "orchestrator_agent";
  }
  return normalized;
}

function applySessionAgentOverrides(agent: AgentConfig, sessionMetadata: Record<string, unknown>): AgentConfig {
  const workspaceRoot = normalizeString(sessionMetadata.workspace_root);
  if (!workspaceRoot) {
    return agent;
  }
  return {
    ...agent,
    custom_params: {
      ...agent.custom_params,
      workspace_root: workspaceRoot,
    },
  };
}

function estimateTokens(content: string): number {
  if (!content) {
    return 0;
  }
  const cjkChars = content.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const nonCjk = content.length - cjkChars;
  return Math.max(1, cjkChars + Math.ceil(nonCjk / 4));
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
