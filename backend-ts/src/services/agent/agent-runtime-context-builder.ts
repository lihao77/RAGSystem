import crypto from "node:crypto";

import type { AgentConfig } from "../../contracts/agent-config.js";
import type { MessageInfo, SessionInfo } from "../../contracts/session.js";
import type { ChatMessage } from "../integrations/llm-chat-client.js";
import { getWorkspaceMemoryKey, MemoryStore, type MemoryScopeSpec } from "../stores/memory-store.js";

export interface RuntimeConversationHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[];
}

export interface RuntimeSessionMetadataPort {
  getSession(sessionId: string): Pick<SessionInfo, "metadata"> | null;
  updateSessionMetadata?(sessionId: string, patch: Record<string, unknown>): Record<string, unknown> | null;
}

export interface RuntimeSystemConfigPort {
  getConfig(): Record<string, unknown>;
}

export interface AgentRuntimeContextRequest {
  sessionId: string;
  threadKey?: string | null;
  historyLimit?: number;
  agent?: AgentConfig | null;
  microcompact?: boolean;
  microcompactKeepRecentTools?: number;
  forceMemoryPrefixRefresh?: boolean;
}

export interface AgentRuntimeContext {
  conversation: ChatMessage[];
  metadata: {
    session_id: string;
    thread_key: string;
    history_limit: number;
    stable_prefix_fingerprint: string | null;
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

export type RuntimeHistoryMessageInfo = MessageInfo;

interface ResolvedAgentRuntimeContextRequest {
  sessionId: string;
  threadKey: string;
  historyLimit: number;
  agent: AgentConfig | null;
  microcompact: boolean;
  microcompactKeepRecentTools: number;
  forceMemoryPrefixRefresh: boolean;
  stablePrefixFingerprint: string | null;
  microcompactTtlSeconds: number;
}

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_THREAD_KEY = "root";
const DEFAULT_INDEX_MAX_LINES = 200;
const DEFAULT_INDEX_MAX_CHARS = 25600;
const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS = 5;
const DEFAULT_MICROCOMPACT_TTL_SECONDS = 600;
const MICROCOMPACT_CLEARED_LABEL = "[工具结果已清理]";

export interface AgentRuntimeContextBuilderOptions {
  systemConfig?: RuntimeSystemConfigPort | undefined;
}

export class AgentRuntimeContextBuilder {
  constructor(
    private readonly sources: AgentRuntimeContextSource[],
    private readonly options: AgentRuntimeContextBuilderOptions = {},
  ) {}

  buildContext(request: AgentRuntimeContextRequest): AgentRuntimeContext {
    const resolved = resolveContextRequest(request);
    resolved.microcompactTtlSeconds = resolveMicrocompactTtlSeconds(this.options.systemConfig?.getConfig());
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
        stable_prefix_fingerprint: resolved.stablePrefixFingerprint ?? "no_stable_prefix",
        sources: sourceMetadata,
      },
    };
  }
}

export class RecentMessagesContextSource implements AgentRuntimeContextSource {
  readonly name = "recent_messages";
  private readonly sessions: RuntimeSessionMetadataPort | null;

  constructor(private readonly history: RuntimeConversationHistoryPort) {
    this.sessions = isRuntimeSessionMetadataPort(history) ? history : null;
  }

  build(request: ResolvedAgentRuntimeContextRequest): AgentRuntimeContextContribution {
    const messages = this.history.getRecentMessages(request.sessionId, request.historyLimit, request.threadKey);
    const filteredMessages = filterRuntimeHistoryMessages(messages);
    const compressionView = resolveCompressionViewDetailed(filteredMessages);
    const historyMessages = compressionView.messages;
    const microcompactDecision = request.microcompact
      ? this.resolveMicrocompactDecision(request)
      : { requested: false, applied: false, reason: "disabled" };
    const microcompact = microcompactDecision.applied
      ? microcompactRuntimeHistoryMessages(historyMessages, request.microcompactKeepRecentTools)
      : {
          messages: historyMessages,
          clearedCount: 0,
          observationCount: countObservationMessages(historyMessages),
        };
    const metadata: Record<string, unknown> = {
      source_message_count: messages.length,
      filtered_message_count: filteredMessages.length,
      resolved_message_count: microcompact.messages.length,
      compression_view: {
        applied: compressionView.applied,
        summary_seq: compressionView.summarySeq,
        replaces_up_to_seq: compressionView.replacesUpToSeq,
      },
    };
    if (request.microcompact) {
      metadata.microcompact = {
        applied: microcompactDecision.applied,
        reason: microcompactDecision.reason,
        keep_recent_tools: request.microcompactKeepRecentTools,
        observation_count: microcompact.observationCount,
        cleared_count: microcompact.clearedCount,
        ttl_seconds: request.microcompactTtlSeconds,
      };
    }
    return {
      conversation: messagesToConversation(microcompact.messages),
      metadata,
    };
  }

  private resolveMicrocompactDecision(request: ResolvedAgentRuntimeContextRequest): {
    requested: boolean;
    applied: boolean;
    reason: string;
  } {
    const metadata = this.sessions?.getSession(request.sessionId)?.metadata ?? {};
    const cache = readPipelineCache(metadata, request.threadKey);
    const currentFingerprint = request.stablePrefixFingerprint ?? "no_stable_prefix";
    const previousFingerprint = getString(cache.fp);
    const lastPreparedAt = typeof cache.t === "number" && Number.isFinite(cache.t) ? cache.t : null;
    const nowSeconds = Date.now() / 1000;
    let applied = false;
    let reason = "cache_fresh";
    if (previousFingerprint !== currentFingerprint) {
      applied = true;
      reason = "fingerprint_changed";
    } else if (lastPreparedAt === null) {
      applied = true;
      reason = "missing_cache_time";
    } else if (nowSeconds - lastPreparedAt >= request.microcompactTtlSeconds) {
      applied = true;
      reason = "ttl_expired";
    }

    return { requested: true, applied, reason };
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

export function isRuntimeStableSystemContextContent(content: string): boolean {
  return content.includes("[Memory Scope Capabilities]") || content.includes("Memory Index]");
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

interface MemoryPrefixSnapshot {
  baseline_key: string;
  session_id: string;
  thread_key: string;
  agent_name: string;
  fingerprint: MemoryPrefixFingerprint;
  scope_capabilities: MemoryScopeCapabilities;
  indices: Record<string, string>;
  rendered_block: string;
  rebased_reason: string;
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
    const baselineKey = memoryBaselineKey(request.threadKey, request.agent.agent_name);
    const existingSnapshot = readMemoryPrefixSnapshot(sessionMetadata, baselineKey);
    const snapshot =
      !request.forceMemoryPrefixRefresh && existingSnapshot?.fingerprint.fingerprint === fingerprint.fingerprint
        ? existingSnapshot
        : this.buildAndPersistSnapshot({
            request,
            baselineKey,
            fingerprint,
            scopeCapabilities,
            scopeSpecs,
          });
    const renderedBlock = snapshot.rendered_block;
    request.stablePrefixFingerprint = snapshot.fingerprint.fingerprint;

    return {
      conversation: renderedBlock ? [{ role: "system", content: renderedBlock }] : [],
      metadata: {
        status: "loaded",
        snapshot,
      },
    };
  }

  private buildAndPersistSnapshot(input: {
    request: ResolvedAgentRuntimeContextRequest;
    baselineKey: string;
    fingerprint: MemoryPrefixFingerprint;
    scopeCapabilities: MemoryScopeCapabilities;
    scopeSpecs: MemoryScopeSpec[];
  }): MemoryPrefixSnapshot {
    const indices: Record<string, string> = {};
    if (input.request.agent?.memory.auto_inject !== false) {
      for (const scopeSpec of input.scopeSpecs) {
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
      scopeCapabilities: input.scopeCapabilities,
      indices,
    });
    const snapshot: MemoryPrefixSnapshot = {
      baseline_key: input.baselineKey,
      session_id: input.request.sessionId,
      thread_key: input.request.threadKey,
      agent_name: input.request.agent?.agent_name ?? "",
      fingerprint: input.fingerprint,
      scope_capabilities: input.scopeCapabilities,
      indices,
      rendered_block: renderedBlock,
      rebased_reason: input.request.forceMemoryPrefixRefresh ? "forced_refresh" : "build_context",
    };
    this.sessions.updateSessionMetadata?.(input.request.sessionId, {
      memory_prefix_states: {
        [input.baselineKey]: snapshot,
      },
    });
    return snapshot;
  }
}

function resolveContextRequest(request: AgentRuntimeContextRequest): ResolvedAgentRuntimeContextRequest {
  return {
    sessionId: request.sessionId,
    threadKey: request.threadKey?.trim() || DEFAULT_THREAD_KEY,
    historyLimit: request.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    agent: request.agent ?? null,
    microcompact: request.microcompact === true,
    microcompactKeepRecentTools: positiveIntegerOrDefault(
      request.microcompactKeepRecentTools,
      DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS,
    ),
    forceMemoryPrefixRefresh: request.forceMemoryPrefixRefresh === true,
    stablePrefixFingerprint: null,
    microcompactTtlSeconds: DEFAULT_MICROCOMPACT_TTL_SECONDS,
  };
}

export function resolveCompressionView(messages: MessageInfo[]): MessageInfo[] {
  return resolveCompressionViewDetailed(messages).messages;
}

export function resolveRuntimeHistoryView(
  messages: MessageInfo[],
): RuntimeHistoryMessageInfo[] {
  const filteredMessages = filterRuntimeHistoryMessages(messages);
  const compressionView = resolveCompressionViewDetailed(filteredMessages);
  return compressionView.messages;
}

export function filterRuntimeHistoryMessages(messages: MessageInfo[]): MessageInfo[] {
  return messages.filter((message) => {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") {
      return false;
    }
    const metadata = message.metadata ?? {};
    const metadataType = metadata.type;
    if (metadataType === "command_result") {
      return false;
    }
    if (metadataType === "command" && metadata.command_mode !== "prompt") {
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

function microcompactRuntimeHistoryMessages(
  messages: RuntimeHistoryMessageInfo[],
  keepRecentTools: number,
): {
  messages: RuntimeHistoryMessageInfo[];
  observationCount: number;
  clearedCount: number;
} {
  const observationIndices = messages
    .map((message, index) => (message.metadata.msg_type === "observation" ? index : -1))
    .filter((index) => index >= 0);
  if (!observationIndices.length || observationIndices.length <= keepRecentTools) {
    return {
      messages,
      observationCount: observationIndices.length,
      clearedCount: 0,
    };
  }

  const clearIndices = new Set(observationIndices.slice(0, observationIndices.length - keepRecentTools));
  let clearedCount = 0;
  const compacted = messages.map((message, index) => {
    if (!clearIndices.has(index)) {
      return message;
    }
    const nextContent = microcompactClearedContent(message);
    if (message.content === nextContent) {
      return message;
    }
    clearedCount += 1;
    return {
      ...message,
      content: nextContent,
    };
  });
  return {
    messages: compacted,
    observationCount: observationIndices.length,
    clearedCount,
  };
}

function countObservationMessages(messages: RuntimeHistoryMessageInfo[]): number {
  return messages.filter((message) => message.metadata.msg_type === "observation").length;
}

function microcompactClearedContent(message: RuntimeHistoryMessageInfo): string {
  if (message.content === MICROCOMPACT_CLEARED_LABEL || message.content.startsWith("[工具结果已清理")) {
    return message.content;
  }
  const round = message.metadata.round;
  return typeof round === "number" && Number.isFinite(round)
    ? `[工具结果已清理，轮次 ${round}]`
    : MICROCOMPACT_CLEARED_LABEL;
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

function readMemoryPrefixSnapshot(
  sessionMetadata: Record<string, unknown>,
  baselineKey: string,
): MemoryPrefixSnapshot | null {
  const states = asRecord(sessionMetadata.memory_prefix_states);
  const snapshot = asRecord(states?.[baselineKey]);
  if (!snapshot) {
    return null;
  }
  const fingerprint = asRecord(snapshot.fingerprint);
  const fingerprintValue = getString(fingerprint?.fingerprint);
  const renderedBlock = typeof snapshot.rendered_block === "string" ? snapshot.rendered_block : null;
  if (!fingerprintValue || renderedBlock === null) {
    return null;
  }
  return {
    baseline_key: getString(snapshot.baseline_key) ?? baselineKey,
    session_id: getString(snapshot.session_id) ?? "",
    thread_key: getString(snapshot.thread_key) ?? DEFAULT_THREAD_KEY,
    agent_name: getString(snapshot.agent_name) ?? "",
    fingerprint: {
      agent_name: getString(fingerprint?.agent_name),
      auto_inject: fingerprint?.auto_inject !== false,
      allowed_scopes: stringArray(fingerprint?.allowed_scopes),
      write_scopes: stringArray(fingerprint?.write_scopes),
      archive_scopes: stringArray(fingerprint?.archive_scopes),
      scope_specs: readFingerprintScopeSpecs(fingerprint?.scope_specs),
      fingerprint: fingerprintValue,
    },
    scope_capabilities: readScopeCapabilities(snapshot.scope_capabilities),
    indices: stringRecord(snapshot.indices),
    rendered_block: renderedBlock,
    rebased_reason: getString(snapshot.rebased_reason) ?? "loaded",
  };
}

function readFingerprintScopeSpecs(value: unknown): MemoryPrefixFingerprint["scope_specs"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record = asRecord(item);
      const scopeName = getString(record?.scope_name);
      const scopeSpec = asRecord(record?.scope_spec);
      if (!scopeName || !scopeSpec || !isMemoryScopeName(scopeSpec.scope)) {
        return null;
      }
      const output: MemoryPrefixFingerprint["scope_specs"][number] = {
        scope_name: scopeName,
        scope_spec: { scope: scopeSpec.scope },
      };
      for (const key of ["team_name", "session_id", "agent_name", "workspace_key"] as const) {
        const stringValue = getString(scopeSpec[key]);
        if (stringValue) {
          output.scope_spec[key] = stringValue;
        }
      }
      return output;
    })
    .filter((item): item is MemoryPrefixFingerprint["scope_specs"][number] => Boolean(item));
}

function readScopeCapabilities(value: unknown): MemoryScopeCapabilities {
  const record = asRecord(value);
  return {
    allowed_scopes: stringArray(record?.allowed_scopes),
    write_scopes: stringArray(record?.write_scopes),
    archive_scopes: stringArray(record?.archive_scopes),
  };
}

function readPipelineCache(sessionMetadata: Record<string, unknown>, threadKey: string): Record<string, unknown> {
  const caches = asRecord(sessionMetadata._pipeline_caches);
  return asRecord(caches?.[threadKey]) ?? {};
}

function resolveMicrocompactTtlSeconds(config: Record<string, unknown> | undefined): number {
  const waiting = asRecord(config?.waiting);
  return positiveNumberOrDefault(waiting?.local_cache_ttl_seconds, DEFAULT_MICROCOMPACT_TTL_SECONDS);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      output[key] = item;
    }
  }
  return output;
}

function isMemoryScopeName(value: unknown): value is MemoryScopeSpec["scope"] {
  return value === "team" || value === "session" || value === "agent" || value === "workspace";
}

function isRuntimeSessionMetadataPort(value: unknown): value is RuntimeSessionMetadataPort {
  return Boolean(value && typeof value === "object" && "getSession" in value && typeof value.getSession === "function");
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

function positiveIntegerOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : defaultValue;
}

function positiveNumberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
