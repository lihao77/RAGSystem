import crypto from "node:crypto";

import type { AgentConfig } from "../contracts/agent-config.js";
import type { RunStepInfo } from "../contracts/common.js";
import type { MessageInfo, SessionInfo } from "../contracts/session.js";
import type { ChatMessage } from "./llm-chat-client.js";
import { getWorkspaceMemoryKey, MemoryStore, type MemoryScopeSpec } from "./memory-store.js";

export interface RuntimeConversationHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[];
  listRunSteps?(input: {
    runId?: string | null;
    messageId?: string | null;
    sessionId?: string | null;
    limit?: number;
  }): RunStepInfo[];
}

export interface RuntimeSessionMetadataPort {
  getSession(sessionId: string): Pick<SessionInfo, "metadata"> | null;
}

export interface AgentRuntimeContextRequest {
  sessionId: string;
  threadKey?: string | null;
  historyLimit?: number;
  agent?: AgentConfig | null;
}

export interface AgentRuntimeContext {
  conversation: ChatMessage[];
  metadata: {
    session_id: string;
    thread_key: string;
    history_limit: number;
    sources: Array<{
      name: string;
      message_count: number;
      metadata?: Record<string, unknown>;
    }>;
  };
}

export interface AgentRuntimeContextContribution {
  conversation?: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface AgentRuntimeContextSource {
  readonly name: string;
  build(request: ResolvedAgentRuntimeContextRequest): AgentRuntimeContextContribution;
}

interface CompressionViewResolution {
  messages: MessageInfo[];
  applied: boolean;
  summarySeq: number | null;
  replacesUpToSeq: number | null;
}

export type RuntimeHistoryMessageInfo = Omit<MessageInfo, "seq"> & { seq: number | null };

interface OrderedExecutionStep {
  payload: Record<string, unknown>;
  stepOrder: number;
}

interface SyntheticRoundBucket {
  intent: OrderedExecutionStep[];
  starts: OrderedExecutionStep[];
  ends: OrderedExecutionStep[];
}

interface ResolvedAgentRuntimeContextRequest {
  sessionId: string;
  threadKey: string;
  historyLimit: number;
  agent: AgentConfig | null;
}

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_THREAD_KEY = "root";
const DEFAULT_INDEX_MAX_LINES = 200;
const DEFAULT_INDEX_MAX_CHARS = 25600;

export class AgentRuntimeContextBuilder {
  constructor(private readonly sources: AgentRuntimeContextSource[]) {}

  buildContext(request: AgentRuntimeContextRequest): AgentRuntimeContext {
    const resolved = resolveContextRequest(request);
    const conversation: ChatMessage[] = [];
    const sourceMetadata: AgentRuntimeContext["metadata"]["sources"] = [];
    for (const source of this.sources) {
      const contribution = source.build(resolved);
      const messages = contribution.conversation ?? [];
      conversation.push(...messages);
      sourceMetadata.push({
        name: source.name,
        message_count: messages.length,
        ...(contribution.metadata ? { metadata: contribution.metadata } : {}),
      });
    }
    return {
      conversation,
      metadata: {
        session_id: resolved.sessionId,
        thread_key: resolved.threadKey,
        history_limit: resolved.historyLimit,
        sources: sourceMetadata,
      },
    };
  }
}

export class RecentMessagesContextSource implements AgentRuntimeContextSource {
  readonly name = "recent_messages";

  constructor(private readonly history: RuntimeConversationHistoryPort) {}

  build(request: ResolvedAgentRuntimeContextRequest): AgentRuntimeContextContribution {
    const messages = this.history.getRecentMessages(request.sessionId, request.historyLimit, request.threadKey);
    const filteredMessages = filterRuntimeHistoryMessages(messages);
    const compressionView = resolveCompressionViewDetailed(filteredMessages);
    const historyMessages = expandMessagesWithRunStepIntermediates(
      compressionView.messages,
      this.history,
      request.sessionId,
    );
    return {
      conversation: messagesToConversation(historyMessages),
      metadata: {
        source_message_count: messages.length,
        filtered_message_count: filteredMessages.length,
        resolved_message_count: historyMessages.length,
        compression_view: {
          applied: compressionView.applied,
          summary_seq: compressionView.summarySeq,
          replaces_up_to_seq: compressionView.replacesUpToSeq,
        },
      },
    };
  }
}

export class EmptyMemoryContextSource implements AgentRuntimeContextSource {
  readonly name = "memory";

  build(): AgentRuntimeContextContribution {
    return {
      conversation: [],
      metadata: {
        status: "not_loaded",
      },
    };
  }
}

interface MemoryIndexContextSourceOptions {
  dataRoot?: string | undefined;
  memoryStore?: MemoryStore | undefined;
  indexMaxLines?: number | undefined;
  indexMaxChars?: number | undefined;
}

interface MemoryScopeCapabilities {
  allowed_scopes: string[];
  write_scopes: string[];
  archive_scopes: string[];
}

interface MemoryPrefixFingerprint {
  agent_name: string | null;
  auto_inject: boolean;
  allowed_scopes: string[];
  write_scopes: string[];
  archive_scopes: string[];
  scope_specs: Array<{
    scope_name: string;
    scope_spec: MemoryScopeSpec;
  }>;
  fingerprint: string;
}

export class MemoryIndexContextSource implements AgentRuntimeContextSource {
  readonly name = "memory";
  private readonly memoryStore: MemoryStore;
  private readonly indexMaxLines: number;
  private readonly indexMaxChars: number;

  constructor(
    private readonly sessions: RuntimeSessionMetadataPort,
    options: MemoryIndexContextSourceOptions = {},
  ) {
    this.memoryStore = options.memoryStore ?? new MemoryStore({ dataRoot: options.dataRoot });
    this.indexMaxLines = options.indexMaxLines ?? DEFAULT_INDEX_MAX_LINES;
    this.indexMaxChars = options.indexMaxChars ?? DEFAULT_INDEX_MAX_CHARS;
  }

  build(request: ResolvedAgentRuntimeContextRequest): AgentRuntimeContextContribution {
    if (!request.agent) {
      return {
        conversation: [],
        metadata: {
          status: "missing_agent",
        },
      };
    }

    const memoryConfig = request.agent.memory;
    const scopeCapabilities = buildMemoryScopeCapabilities(memoryConfig);
    const memoryEnabled = Boolean(
      scopeCapabilities.allowed_scopes.length ||
        scopeCapabilities.write_scopes.length ||
        scopeCapabilities.archive_scopes.length,
    );
    if (!memoryEnabled && memoryConfig.auto_inject === false) {
      return {
        conversation: [],
        metadata: {
          status: "disabled",
          scope_capabilities: scopeCapabilities,
        },
      };
    }

    const sessionMetadata = this.sessions.getSession(request.sessionId)?.metadata ?? {};
    const scopeSpecs = buildMemoryScopeSpecs({
      memoryConfig,
      sessionId: request.sessionId,
      agentName: request.agent.agent_name,
      sessionMetadata,
    });
    const fingerprint = buildMemoryPrefixFingerprint({
      memoryConfig,
      scopeCapabilities,
      scopeSpecs,
      agentName: request.agent.agent_name,
    });
    const indices: Record<string, string> = {};
    if (memoryConfig.auto_inject !== false) {
      for (const scopeSpec of scopeSpecs) {
        const content = this.memoryStore.loadIndexHead(scopeSpec, {
          maxLines: this.indexMaxLines,
          maxChars: this.indexMaxChars,
        });
        if (content) {
          indices[scopeSpec.scope] = content;
        }
      }
    }
    const renderedBlock = renderMemoryPrefixBlock({
      scopeCapabilities,
      indices,
    });
    const snapshot = {
      baseline_key: memoryBaselineKey(request.threadKey, request.agent.agent_name),
      session_id: request.sessionId,
      thread_key: request.threadKey,
      agent_name: request.agent.agent_name,
      fingerprint,
      scope_capabilities: scopeCapabilities,
      indices,
      rendered_block: renderedBlock,
      rebased_reason: "build_context",
    };

    return {
      conversation: renderedBlock ? [{ role: "system", content: renderedBlock }] : [],
      metadata: {
        status: "loaded",
        snapshot,
      },
    };
  }
}

function resolveContextRequest(request: AgentRuntimeContextRequest): ResolvedAgentRuntimeContextRequest {
  return {
    sessionId: request.sessionId,
    threadKey: request.threadKey?.trim() || DEFAULT_THREAD_KEY,
    historyLimit: request.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    agent: request.agent ?? null,
  };
}

export function resolveCompressionView(messages: MessageInfo[]): MessageInfo[] {
  return resolveCompressionViewDetailed(messages).messages;
}

export function resolveRuntimeHistoryView(
  messages: MessageInfo[],
  history: RuntimeConversationHistoryPort,
  sessionId: string,
): RuntimeHistoryMessageInfo[] {
  const filteredMessages = filterRuntimeHistoryMessages(messages);
  const compressionView = resolveCompressionViewDetailed(filteredMessages);
  return expandMessagesWithRunStepIntermediates(compressionView.messages, history, sessionId);
}

export function filterRuntimeHistoryMessages(messages: MessageInfo[]): MessageInfo[] {
  return messages.filter((message) => {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") {
      return false;
    }
    const metadata = message.metadata ?? {};
    const metadataType = metadata.type;
    if (metadataType === "command" || metadataType === "command_result") {
      return false;
    }
    if (metadata.display_only) {
      return false;
    }
    if (metadata.hidden) {
      return false;
    }
    if (message.role === "assistant" && metadata.interrupted) {
      return false;
    }
    return true;
  });
}

function resolveCompressionViewDetailed(messages: MessageInfo[]): CompressionViewResolution {
  if (!messages.length) {
    return {
      messages: [],
      applied: false,
      summarySeq: null,
      replacesUpToSeq: null,
    };
  }

  let compressionMessage: MessageInfo | null = null;
  let compressionIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (!message.metadata.compression) {
      continue;
    }
    if (!compressionMessage || message.seq > compressionMessage.seq) {
      compressionMessage = message;
      compressionIndex = index;
    }
  }

  if (!compressionMessage) {
    return {
      messages: [...messages],
      applied: false,
      summarySeq: null,
      replacesUpToSeq: null,
    };
  }

  const replacesUpToSeq = numberOrNull(compressionMessage.metadata.replaces_up_to_seq);
  const cutoff = replacesUpToSeq ?? compressionMessage.seq;
  const output: MessageInfo[] = [
    {
      ...compressionMessage,
      role: "assistant",
      metadata: {
        compression: true,
      },
    },
  ];

  for (const [index, message] of messages.entries()) {
    if (index === compressionIndex || message.metadata.compression) {
      continue;
    }
    if (message.seq > cutoff) {
      output.push(message);
    }
  }

  return {
    messages: output,
    applied: true,
    summarySeq: compressionMessage.seq,
    replacesUpToSeq,
  };
}

function messagesToConversation(messages: RuntimeHistoryMessageInfo[]): ChatMessage[] {
  const conversation: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant" || message.role === "system") {
      conversation.push({ role: message.role, content: message.content });
    }
  }
  return conversation;
}

function expandMessagesWithRunStepIntermediates(
  messages: MessageInfo[],
  history: RuntimeConversationHistoryPort,
  sessionId: string,
): RuntimeHistoryMessageInfo[] {
  const persistedIntermediateRunIds = new Set<string>();
  for (const message of messages) {
    const runId = getString(message.metadata.run_id);
    if (runId && message.metadata.react_intermediate) {
      persistedIntermediateRunIds.add(runId);
    }
  }

  const expanded: RuntimeHistoryMessageInfo[] = [];
  for (const message of messages) {
    const runId = getString(message.metadata.run_id);
    const shouldSynthesize =
      Boolean(history.listRunSteps) &&
      message.role === "assistant" &&
      Boolean(runId) &&
      !message.metadata.react_intermediate &&
      !persistedIntermediateRunIds.has(runId!);
    if (shouldSynthesize && runId) {
      expanded.push(...synthesizeRunStepIntermediateMessages(message, history, sessionId, runId));
    }
    expanded.push(message);
  }
  return expanded;
}

function synthesizeRunStepIntermediateMessages(
  finalMessage: MessageInfo,
  history: RuntimeConversationHistoryPort,
  sessionId: string,
  runId: string,
): RuntimeHistoryMessageInfo[] {
  const steps = history.listRunSteps?.({ runId, sessionId, limit: 2000 }) ?? [];
  const executionSteps = steps
    .filter((step) => step.step_type === "execution.step")
    .filter((step) => isRecord(step.payload))
    .map((step) => ({ payload: step.payload, stepOrder: step.step_order }))
    .sort((left, right) => left.stepOrder - right.stepOrder);
  if (executionSteps.length === 0) {
    return [];
  }

  const byRound = new Map<number, SyntheticRoundBucket>();
  const toolStartRoundByCallId = new Map<string, number>();
  let latestRound = 0;
  for (const step of executionSteps) {
    const kind = getString(step.payload.kind);
    const phase = getString(step.payload.phase);
    if (kind !== "intent" && kind !== "tool") {
      continue;
    }
    const callId = getString(step.payload.call_id) ?? getString(step.payload.tool_call_id);
    const payloadRound = numberOrNull(step.payload.round);
    const round =
      kind === "tool" && phase === "end" && callId && toolStartRoundByCallId.has(callId)
        ? toolStartRoundByCallId.get(callId)!
        : payloadRound ?? latestRound;
    latestRound = round;
    if (kind === "tool" && phase === "start" && callId) {
      toolStartRoundByCallId.set(callId, round);
    }
    const bucket = byRound.get(round) ?? { intent: [], starts: [], ends: [] };
    if (kind === "intent" && phase === "complete") {
      bucket.intent.push(step);
    } else if (kind === "tool" && phase === "start") {
      bucket.starts.push(step);
    } else if (kind === "tool" && phase === "end") {
      bucket.ends.push(step);
    }
    byRound.set(round, bucket);
  }

  const synthesized: RuntimeHistoryMessageInfo[] = [];
  const rounds = [...byRound.keys()].sort((left, right) => left - right);
  for (const round of rounds) {
    const bucket = byRound.get(round);
    if (!bucket) {
      continue;
    }
    const intentContent = renderSyntheticIntentContent(bucket.intent, bucket.starts);
    if (intentContent) {
      synthesized.push(makeSyntheticIntermediateMessage(finalMessage, {
        role: "assistant",
        content: intentContent,
        msgType: "intent",
        round: toPythonDisplayRound(round),
        runId,
      }));
    }
    const observationContent = renderSyntheticObservationContent(bucket.ends);
    if (observationContent) {
      synthesized.push(makeSyntheticIntermediateMessage(finalMessage, {
        role: "user",
        content: observationContent,
        msgType: "observation",
        round: toPythonDisplayRound(round),
        runId,
      }));
    }
  }

  return synthesized;
}

function renderSyntheticIntentContent(intentSteps: OrderedExecutionStep[], toolStarts: OrderedExecutionStep[]): string {
  const explicitIntent = intentSteps
    .map((step) => getString(step.payload.content))
    .filter((content): content is string => Boolean(content))
    .join("\n")
    .trim();
  const toolXml = renderSyntheticToolCallsXml(toolStarts);
  if (explicitIntent && toolXml) {
    return `${explicitIntent}\n\n${toolXml}`;
  }
  return explicitIntent || toolXml;
}

function renderSyntheticToolCallsXml(toolStarts: OrderedExecutionStep[]): string {
  const orderedToolStarts = sortStepsByActionOrder(toolStarts);
  if (!orderedToolStarts.length) {
    return "";
  }
  const tools = orderedToolStarts
    .map((step) => {
      const toolName = getString(step.payload.tool_name) ?? "unknown_tool";
      const args = isRecord(step.payload.arguments) ? step.payload.arguments : {};
      const params = Object.entries(args).map(([key, value]) => renderXmlParameter(key, value)).join("\n");
      return [`<tool name="${escapeXmlAttribute(toolName)}">`, params, "</tool>"].filter(Boolean).join("\n");
    })
    .join("\n");
  return `<tools>\n${tools}\n</tools>`;
}

function renderXmlParameter(key: string, value: unknown): string {
  const safeKey = /^[A-Za-z_][\w:-]*$/.test(key) ? key : "param";
  if (Array.isArray(value)) {
    const items = value.map((item) => `  <item>${escapeXmlText(renderArgumentValue(item))}</item>`).join("\n");
    return `<${safeKey}>\n${items}\n</${safeKey}>`;
  }
  return `<${safeKey}>${escapeXmlText(renderArgumentValue(value))}</${safeKey}>`;
}

function renderArgumentValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function renderSyntheticObservationContent(steps: OrderedExecutionStep[]): string {
  return sortStepsByActionOrder(steps)
    .map(renderSingleSyntheticObservationContent)
    .filter((content): content is string => Boolean(content))
    .join("\n\n");
}

function sortStepsByActionOrder(steps: OrderedExecutionStep[]): OrderedExecutionStep[] {
  return [...steps].sort((left, right) => {
    const leftOrder = numberOrNull(left.payload.order) ?? numberOrNull(left.payload.round_index);
    const rightOrder = numberOrNull(right.payload.order) ?? numberOrNull(right.payload.round_index);
    if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    if (leftOrder !== null && rightOrder === null) {
      return -1;
    }
    if (leftOrder === null && rightOrder !== null) {
      return 1;
    }
    return left.stepOrder - right.stepOrder;
  });
}

function renderSingleSyntheticObservationContent(step: OrderedExecutionStep): string {
  const payload = step.payload;
  const toolName = getString(payload.tool_name) ?? "tool";
  const rawResult =
    getString(payload.observation) ??
    getString(payload.result_preview) ??
    getString(payload.result) ??
    getString(payload.summary) ??
    "";
  if (!rawResult.trim()) {
    return "";
  }
  if (rawResult.trimStart().startsWith("<tool_result")) {
    return rawResult;
  }
  return rawResult.trimStart().startsWith(`[${toolName}]`) ? rawResult : `[${toolName}]\n${rawResult}`;
}

function toPythonDisplayRound(round: number): number {
  return round + 1;
}

function makeSyntheticIntermediateMessage(
  base: MessageInfo,
  input: {
    role: "user" | "assistant";
    content: string;
    msgType: string;
    round: number;
    runId: string;
  },
): RuntimeHistoryMessageInfo {
  return {
    ...base,
    id: `${base.id}:synthetic:${input.msgType}:${input.round}:${crypto
      .createHash("sha1")
      .update(input.content)
      .digest("hex")
      .slice(0, 8)}`,
    seq: null,
    role: input.role,
    content: input.content,
    metadata: {
      ...base.metadata,
      react_intermediate: true,
      synthetic: true,
      msg_type: input.msgType,
      round: input.round,
      run_id: input.runId,
    },
  };
}

function buildMemoryScopeCapabilities(memoryConfig: AgentConfig["memory"]): MemoryScopeCapabilities {
  return {
    allowed_scopes: [...(memoryConfig.allowed_scopes ?? [])],
    write_scopes: [...(memoryConfig.write_scopes ?? [])],
    archive_scopes: [...(memoryConfig.archive_scopes ?? [])],
  };
}

function buildMemoryScopeSpecs(input: {
  memoryConfig: AgentConfig["memory"];
  sessionId: string;
  agentName: string;
  sessionMetadata: Record<string, unknown>;
}): MemoryScopeSpec[] {
  const allowedScopes = new Set(input.memoryConfig.allowed_scopes ?? []);
  const teamName = getString(input.sessionMetadata.team);
  const workspaceKey = getWorkspaceMemoryKey(getString(input.sessionMetadata.workspace_root));
  const scopeSpecs: MemoryScopeSpec[] = [];
  if (allowedScopes.has("team") && teamName) {
    scopeSpecs.push({ scope: "team", team_name: teamName });
  }
  if (allowedScopes.has("session")) {
    scopeSpecs.push({ scope: "session", session_id: input.sessionId });
  }
  if (allowedScopes.has("agent") && input.agentName && teamName) {
    scopeSpecs.push({ scope: "agent", agent_name: input.agentName, team_name: teamName });
  }
  if (allowedScopes.has("workspace") && workspaceKey) {
    scopeSpecs.push({ scope: "workspace", workspace_key: workspaceKey });
  }
  return scopeSpecs;
}

function buildMemoryPrefixFingerprint(input: {
  memoryConfig: AgentConfig["memory"];
  scopeCapabilities: MemoryScopeCapabilities;
  scopeSpecs: MemoryScopeSpec[];
  agentName: string;
}): MemoryPrefixFingerprint {
  const payload = {
    agent_name: input.agentName.trim() || null,
    auto_inject: input.memoryConfig.auto_inject !== false,
    allowed_scopes: [...input.scopeCapabilities.allowed_scopes].sort(),
    write_scopes: [...input.scopeCapabilities.write_scopes].sort(),
    archive_scopes: [...input.scopeCapabilities.archive_scopes].sort(),
    scope_specs: input.scopeSpecs.map((scopeSpec) => ({
      scope_name: scopeSpec.scope,
      scope_spec: { ...scopeSpec },
    })),
  };
  return {
    ...payload,
    fingerprint: crypto.createHash("sha256").update(pythonStableJsonStringify(payload), "utf8").digest("hex").slice(0, 16),
  };
}

function renderMemoryPrefixBlock(input: {
  scopeCapabilities: MemoryScopeCapabilities;
  indices: Record<string, string>;
}): string {
  const sections: string[] = [];
  const allowedScopes = input.scopeCapabilities.allowed_scopes;
  const writeScopes = input.scopeCapabilities.write_scopes;
  const archiveScopes = input.scopeCapabilities.archive_scopes;
  if (allowedScopes.length || writeScopes.length || archiveScopes.length) {
    sections.push(
      [
        "[Memory Scope Capabilities]",
        `- 可读取 scope: ${allowedScopes.length ? allowedScopes.join(", ") : "无"}`,
        `- 可写入 scope: ${writeScopes.length ? writeScopes.join(", ") : "无"}`,
        `- 可归档 scope: ${archiveScopes.length ? archiveScopes.join(", ") : "无"}`,
        "- 执行 memory 工具前，必须先确认目标 scope 在对应权限列表内，避免误操作",
      ].join("\n"),
    );
  }

  const scopeTitles: Record<string, string> = {
    team: "Team",
    session: "Session",
    agent: "Agent",
    workspace: "Workspace",
  };
  for (const [scopeName, content] of Object.entries(input.indices)) {
    if (!content) {
      continue;
    }
    sections.push(`[${scopeTitles[scopeName] ?? titleCase(scopeName)} Memory Index]\n${content.trim()}`);
  }
  return sections.join("\n\n");
}

function memoryBaselineKey(threadKey: string, agentName: string | null): string {
  return `${threadKey.trim() || DEFAULT_THREAD_KEY}::${agentName?.trim() || "_anonymous_"}`;
}

function pythonStableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonStableJsonStringify(item)).join(", ")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${pythonStableJsonStringify(value[key])}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
