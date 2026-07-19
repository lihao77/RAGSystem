import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { AgentConfig } from "../../contracts/agent-config.js";
import { ok } from "../../contracts/common.js";
import type { OutboxStatus } from "../../contracts/conversation-store/index.js";
import { MSG_TYPE } from "../../contracts/message-kinds.js";
import { resolveContextCompressionSettings } from "../../services/agent/context-compression/index.js";
import { createToolRegistry, resolveContextBudget } from "@ragsystem/agent-sdk";
import { projectAgentProfile } from "../../services/agent/sdk/projection.js";
import { HISTORY_SCAN_LIMIT, previewBackendAgentContext, type ConversationHistoryPort, type SessionMetadataPort } from "../../services/agent/context/index.js";
import { createBackendTools } from "../../tools/registry.js";
import { PathApprovalService } from "../../services/runtime/path-service.js";
import type { ChatMessage, ChatToolCall } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import type { MonitoringApplication } from "../../contracts/monitoring-application.js";
import { LocalMonitoringApplication } from "../../adapters/local/local-monitoring-application.js";
import { requireTenantAdmin, requireTenantMember } from "../tenant-role.js";
import { assertSessionOwner } from "../session-owner.js";
import { isRecord, normalizeString } from "../../utils/guards.js";

interface ContextSnapshotQuery {
  session_id?: string;
  selected_llm?: string;
  /** 指定会话线程（子智能体 thread，如 "child:<id>"）；不传走 root。前端 UI 预留。 */
  thread_key?: string;
}

interface OutboxListQuery {
  status?: string;
  session_id?: string;
  run_id?: string;
  limit?: string;
  offset?: string;
}

interface OutboxCleanupQuery {
  before?: string;
  older_than_hours?: string;
  limit?: string;
}

export const registerMonitoringRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const resolveMonitoring = async (request: FastifyRequest): Promise<MonitoringApplication> =>
    await options.resolveMonitoringApplication?.(request)
      ?? new LocalMonitoringApplication(request.container.conversationStore);
  app.addHook("preHandler", async (request) => {
    requireTenantMember(request);
    if (request.method !== "GET" || request.url.includes("/event-outbox") || request.url.includes("/metrics")) requireTenantAdmin(request);
  });

  app.get("/metrics", async (request) => {
    const query = request.query as { agent_name?: string };
    const agentName = query.agent_name?.trim() || null;
    return ok({
      ...request.container.metricsCollector.getSystemMetrics(agentName),
      scope: "node",
    }, "获取节点指标成功");
  });

  app.post("/metrics/reset", async (request) => {
    const body = isRecord(request.body) ? request.body : {};
    const agentName = typeof body.agent_name === "string" && body.agent_name.trim() ? body.agent_name.trim() : null;
    const result = request.container.metricsCollector.reset(agentName);
    return ok(result, `已重置${agentName ? `智能体 ${agentName}` : "所有"}指标`);
  });

  app.get("/event-outbox", async (request) => {
    const query = request.query as OutboxListQuery;
    const input = {
      statuses: parseOutboxStatuses(query.status),
      sessionId: normalizeString(query.session_id),
      runId: normalizeString(query.run_id),
      limit: parseIntegerQuery(query.limit, "limit", { defaultValue: 100, min: 1, max: 500 }),
      offset: parseIntegerQuery(query.offset, "offset", { defaultValue: 0, min: 0, max: 100_000 }),
    };
    const monitoring = await resolveMonitoring(request);
    return ok(
      await monitoring.listOutbox(input),
      "获取 outbox 事件成功",
    );
  });

  app.get<{ Params: { id: string } }>("/event-outbox/:id", async (request) => {
    const id = parsePositiveInteger(request.params.id, "id");
    const monitoring = await resolveMonitoring(request);
    const row = await monitoring.getOutboxRow(id);
    if (!row) {
      throw new HttpError(404, "not_found", "outbox 事件不存在");
    }
    return ok(row, "获取 outbox 事件成功");
  });

  app.post<{ Params: { id: string } }>("/event-outbox/:id/retry", async (request) => {
    const id = parsePositiveInteger(request.params.id, "id");
    const monitoring = await resolveMonitoring(request);
    const retried = await monitoring.retryOutbox(id);
    if (!retried) {
      throw new HttpError(409, "outbox_not_retryable", "outbox 事件不存在或当前状态不可重试");
    }
    return ok({ id, retried: true }, "outbox 事件已重新入队");
  });

  app.post("/event-outbox/retry", async (request) => {
    const body = isRecord(request.body) ? request.body : {};
    const ids = parseIdArray(body.ids);
    const statuses = parseOutboxStatuses(typeof body.status === "string" ? body.status : undefined);
    const input = {
      ids,
      statuses: statuses.length > 0 ? statuses : undefined,
      limit: parseIntegerValue(body.limit, "limit", { defaultValue: 100, min: 1, max: 500 }),
    };
    const monitoring = await resolveMonitoring(request);
    const result = await monitoring.retryOutboxBatch(input);
    return ok(result, "outbox 事件已批量重新入队");
  });

  app.delete("/event-outbox/delivered", async (request) => {
    const query = request.query as OutboxCleanupQuery;
    const before = parseCleanupBefore(query);
    const input = {
      before,
      limit: parseIntegerQuery(query.limit, "limit", { defaultValue: 1000, min: 1, max: 10_000 }),
    };
    const monitoring = await resolveMonitoring(request);
    const deleted = await monitoring.deleteDeliveredOutbox(input);
    return ok({ deleted, before }, "已清理 delivered outbox 事件");
  });

  app.get("/context-snapshot", async (request) => {
    const query = request.query as ContextSnapshotQuery;
    const sessionId = normalizeString(query.session_id);
    const saasSession = await options.resolveSessionApplication?.(request);
    const saasSessionInfo = sessionId && saasSession ? await saasSession.getSession(sessionId) : null;
    if (sessionId && saasSession) {
      if (!saasSessionInfo) throw new HttpError(404, "not_found", "会话不存在");
      await assertSessionOwner(request, saasSessionInfo);
    }
    const sessionMetadata = saasSessionInfo?.metadata
      ?? (sessionId ? request.container.conversationStore.getSession(sessionId)?.metadata ?? {} : {});
    const resolved = request.container.runtimeCore.resolveExecutionConfig({
      agentName: normalizeSessionEntryAgent(sessionMetadata.entry_agent),
      teamName: normalizeString(sessionMetadata.team),
      selectedLlm: normalizeString(query.selected_llm),
    });
    if (!resolved.agent) {
      throw new HttpError(503, "runtime_not_ready", "默认入口智能体未加载");
    }

    const agent = applySessionAgentOverrides(resolved.agent, sessionMetadata);
    const teamName = normalizeString(sessionMetadata.team);

    // 装配 createRuntime（轻量，只 preview 不 run）—— preview 内部用 SDK builder + protocol.buildRequest，
    // 与 run 完全同源（同一套组请求代码），调试快照即真实 run 所见。snapshot 不再 backend 自组装。
    const profile = projectAgentProfile({
      agent,
      providers: request.container.modelAdapter.listProviders(),
      // 仅当前端真选了 selected_llm 才整体替换 default;否则用 agent default tier(保留 tier 配的窗口等参数)。
      ...(normalizeString(query.selected_llm) && resolved.provider && resolved.modelName
        ? { selectedLlm: { provider: resolved.provider, modelName: resolved.modelName } }
        : {}),
    });
    // preview 仅 projection（组请求快照）——不跑工具循环、不注册 gate-hook，
    // 故 pathService 不会被 approve/isApproved 调用；此处占位仅为满足 createBackendTools 签名。
    const registry = createToolRegistry({
      tools: createBackendTools({
        ...request.container.toolsDeps,
        agent,
        ...(teamName ? { teamName } : {}),
      }, new PathApprovalService()),
    });
    // backend 组装 context（memory + recent）—— 与 run 路径同源（runtime-adapter 同一套 builder + source）。
    // conversation 注入 preview（组 LLM request）；rawMessages/sources 由 backend 自组，preview 不再返回 context。
    const threadKey = normalizeString(query.thread_key);
    const historyPort: ConversationHistoryPort & SessionMetadataPort & Partial<Pick<typeof request.container.conversationStore, "listMemoryCandidates">> = {
      getRecentMessages: (sid, limit, tk) => saasSession
        ? saasSession.getRecentMessages(sid, limit ?? HISTORY_SCAN_LIMIT, tk ?? "root")
        : request.container.conversationStore.getRecentMessages(sid, limit ?? HISTORY_SCAN_LIMIT, tk ?? "root"),
      getSession: (sid) => {
        const s = saasSessionInfo && sid === sessionId
          ? saasSessionInfo
          : request.container.conversationStore.getSession(sid);
        return s ? { metadata: s.metadata ?? {}, user_id: s.user_id } : null;
      },
      ...(saasSession ? {} : { updateSessionMetadata: (sid: string, patch: Record<string, unknown>) => request.container.conversationStore.updateSessionMetadata(sid, patch) }),
      ...(saasSession ? {} : { listMemoryCandidates: (candidateQuery: Parameters<typeof request.container.conversationStore.listMemoryCandidates>[0]) => request.container.conversationStore.listMemoryCandidates(candidateQuery) }),
    };
    const snapshot = sessionId
      ? await previewBackendAgentContext(agent, profile, historyPort, registry, {
          memoryConfig: request.container.systemConfig.getMemoryConfig(),
          dataRoot: request.container.dataRoot,
          sessionId,
          threadKey,
          ...(saasSession ? { memoryContextSourceFactory: request.container.memoryContextSourceFactory } : {}),
        })
      : null;
    const built = snapshot?.built ?? null;
    const preview = snapshot?.preview ?? null;

    const memorySnapshot = getMemorySnapshot(built?.metadata.sources ?? []);
    // conversation_history 走 LLM 实际收到的 conversation 投影后 content(prompt 命令展开 / 图片 ContentPart)。
    // conversation = memory 段 + recent 段;rawMessages 只覆盖 recent 段(recent-messages-source 的 rawMessages 即
    // messagesToConversation 的 originals,与 recent conversation 1:1)。约定:仅 recent source 贡献 rawMessages,
    // memory 等其他 source 不贡献;未来若新增贡献 rawMessages 的 source,此 recentOffset 对齐需重审。
    // conversation_history 只展示 recent 对话历史段(memory system prefix 属注入上下文,不混入对话历史),按 index 对齐回绑 seq/msg_type。
    const convMessages = built?.conversation ?? [];
    const rawOriginals = built?.rawMessages ?? [];
    const recentOffset = Math.max(0, convMessages.length - rawOriginals.length);
    const history = convMessages.slice(recentOffset).map((msg, i) => {
      const rm = rawOriginals[i] ?? null;
      return toContextHistoryItem(msg, rm ? { seq: rm.seq, metadata: rm.metadata } : undefined);
    });
    // memory block 已作为 system 消息进 request.messages，preview.tokenStats.systemPromptTokens 已含它，不重复加。
    const systemPromptTokens = preview?.tokenStats.systemPromptTokens ?? 0;
    const historyTokens = preview?.tokenStats.historyTokens ?? 0;
    const budgetTokens = resolveContextBudget(profile.llmTiers, preview?.tokenStats.systemPromptTokens ?? 0, profile.behavior.budget);

    const data = {
      system_prompt: preview?.systemPrompt ?? "",
      available_agent_tools: buildAvailableAgentTools(agent, teamName, request.container),
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
        compression: buildCompressionConfig(agent, request.container),
        model: resolved.modelName ?? agent.llm_tiers?.default?.model_name ?? "",
        ...(query.selected_llm ? { llm_override: parseSelectedLlmForSnapshot(query.selected_llm) } : {}),
      },
      available_tools: (preview?.toolDefinitions ?? []).map((tool) => ({ name: tool.name, description: tool.description })),
      available_skills: buildAvailableSkills(agent, request.container),
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

};

function toContextHistoryItem(
  message: ChatMessage,
  original: { seq: number | null; metadata: Record<string, unknown> } | undefined,
): {
  seq: number | null;
  role: string;
  content_preview: string;
  content_length: number;
  tokens: number;
  is_compression_summary: boolean;
  react_intermediate: boolean;
  msg_type: string | null;
  round: number | null;
  tool_calls?: ChatToolCall[];
  tool_call_id: string | null;
  name: string | null;
} {
  const text = extractText(message.content);
  return {
    seq: original?.seq ?? null,
    role: message.role,
    content_preview: text,
    content_length: text.length,
    tokens: estimateTokens(text),
    is_compression_summary: original?.metadata.msg_type === MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY,
    react_intermediate: Boolean(original?.metadata.react_intermediate),
    msg_type: normalizeString(original?.metadata.msg_type),
    round: typeof original?.metadata.round === "number" ? original.metadata.round : null,
    ...(message.tool_calls && message.tool_calls.length > 0 ? { tool_calls: message.tool_calls } : {}),
    tool_call_id: message.tool_call_id ?? null,
    name: message.name ?? null,
  };
}

function buildCompressionConfig(agent: AgentConfig, container: FastifyRequest["container"]): Record<string, unknown> {
  const settings = resolveContextCompressionSettings(agent, container.systemConfig.getConfig());
  return {
    strategy: "llm_summarize",
    trigger_ratio: settings.compressionTriggerRatio,
    preserve_recent_turns: settings.preserveRecentTurns,
    summarize_max_tokens: settings.summarizeMaxTokens,
  };
}

function buildAvailableAgentTools(
  agent: AgentConfig,
  teamName: string | null,
  container: FastifyRequest["container"],
): Array<Record<string, unknown>> {
  return (agent.delegation.enabled_agents ?? []).map((agentName) => {
    const config = container.agentConfig.getConfig(agentName, { teamName });
    if (!config) {
      return {
        name: agentName,
        display_name: agentName,
        use_cases: null,
        description: null,
      };
    }
    return {
      name: config.agent_name,
      display_name: config.display_name ?? config.agent_name,
      use_cases: null,
      description: config.description ?? null,
    };
  });
}

function buildAvailableSkills(agent: AgentConfig, container: FastifyRequest["container"]): Array<Record<string, unknown>> {
  const available = container.agentConfig.listAvailableSkills();
  const byName = new Map<string, Record<string, unknown>>();
  for (const item of available) {
    if (isRecord(item)) {
      const name = normalizeString(item.name);
      if (name) {
        byName.set(name, item);
      }
    }
  }
  return (agent.skills.enabled_skills ?? [])
    .filter((name) => byName.has(name))
    .map((name) => {
      const source = byName.get(name) ?? {};
      return {
        name,
        source_type: normalizeString(source.source_type) ?? "user_global",
        source_label: normalizeString(source.source_label) ?? "全局",
        is_auto_inject_candidate: Boolean(source.is_auto_inject_candidate ?? false),
        content_length: typeof source.content_length === "number" ? source.content_length : 0,
        metadata: { name },
        description: normalizeString(source.description) ?? "",
      };
    });
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

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}



function parseOutboxStatuses(value: string | undefined): OutboxStatus[] {
  if (!value?.trim()) {
    return [];
  }
  const statuses: OutboxStatus[] = [];
  for (const item of value.split(",")) {
    const status = item.trim();
    if (!status) {
      continue;
    }
    if (!isOutboxStatus(status)) {
      throw new HttpError(400, "invalid_request", `无效 outbox status: ${status}`);
    }
    if (!statuses.includes(status)) {
      statuses.push(status);
    }
  }
  return statuses;
}

function isOutboxStatus(value: string): value is OutboxStatus {
  return value === "pending" || value === "retrying" || value === "delivered" || value === "failed";
}

function parseIdArray(value: unknown): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "ids 必须是数字数组");
  }
  const ids = value.map((item) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      throw new HttpError(400, "invalid_request", "ids 必须是正整数数组");
    }
    return item;
  });
  return [...new Set(ids)];
}

function parseIntegerQuery(
  value: string | undefined,
  field: string,
  bounds: { defaultValue: number; min: number; max: number },
): number {
  if (value === undefined || value === "") {
    return bounds.defaultValue;
  }
  return parseBoundedInteger(Number(value), field, bounds);
}

function parseIntegerValue(
  value: unknown,
  field: string,
  bounds: { defaultValue: number; min: number; max: number },
): number {
  if (value === undefined || value === null) {
    return bounds.defaultValue;
  }
  return parseBoundedInteger(value, field, bounds);
}

function parseBoundedInteger(
  value: unknown,
  field: string,
  bounds: { defaultValue: number; min: number; max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new HttpError(400, "invalid_request", `${field} 必须是整数`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new HttpError(400, "invalid_request", `${field} 必须在 ${bounds.min} 到 ${bounds.max} 之间`);
  }
  return value;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "invalid_request", `${field} 必须是正整数`);
  }
  return parsed;
}

function parseCleanupBefore(query: OutboxCleanupQuery): string {
  const explicitBefore = normalizeString(query.before);
  if (explicitBefore) {
    const timestamp = Date.parse(explicitBefore);
    if (!Number.isFinite(timestamp)) {
      throw new HttpError(400, "invalid_request", "before 必须是有效时间");
    }
    return new Date(timestamp).toISOString();
  }
  const olderThanHours = parseIntegerQuery(query.older_than_hours, "older_than_hours", {
    defaultValue: 24,
    min: 1,
    max: 24 * 365,
  });
  return new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
}
