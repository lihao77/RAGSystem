import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../contracts/agent-config.js";
import type { MessageInfo, SessionInfo } from "../contracts/session.js";
import type { ChatMessage } from "./llm-chat-client.js";

export interface RuntimeConversationHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[];
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
    return {
      conversation: messagesToConversation(messages),
      metadata: {
        source_message_count: messages.length,
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
  indexMaxLines?: number | undefined;
  indexMaxChars?: number | undefined;
}

type MemoryScopeName = "team" | "session" | "agent" | "workspace";

interface MemoryScopeSpec {
  scope: MemoryScopeName;
  team_name?: string;
  session_id?: string;
  agent_name?: string;
  workspace_key?: string;
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
  private readonly dataRoot: string;
  private readonly indexMaxLines: number;
  private readonly indexMaxChars: number;

  constructor(
    private readonly sessions: RuntimeSessionMetadataPort,
    options: MemoryIndexContextSourceOptions = {},
  ) {
    this.dataRoot = path.resolve(options.dataRoot?.trim() || path.join(os.homedir(), ".ragsystem"));
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
        const content = this.loadIndexHead(scopeSpec);
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

  private loadIndexHead(scopeSpec: MemoryScopeSpec): string {
    const indexPath = path.join(this.resolveScopeRoot(scopeSpec), "MEMORY.md");
    try {
      if (!fs.existsSync(indexPath)) {
        return "";
      }
      const text = fs.readFileSync(indexPath, "utf8");
      const limited = text.split(/\r?\n/).slice(0, this.indexMaxLines).join("\n");
      return limited.slice(0, this.indexMaxChars).trim();
    } catch {
      return "";
    }
  }

  private resolveScopeRoot(scopeSpec: MemoryScopeSpec): string {
    const memoryRoot = path.join(this.dataRoot, "memory");
    if (scopeSpec.scope === "team") {
      return path.join(memoryRoot, "teams", scopeSpec.team_name ?? "");
    }
    if (scopeSpec.scope === "session") {
      return path.join(memoryRoot, "sessions", scopeSpec.session_id ?? "");
    }
    if (scopeSpec.scope === "agent") {
      return path.join(memoryRoot, "teams", scopeSpec.team_name ?? "", "agents", scopeSpec.agent_name ?? "");
    }
    return path.join(memoryRoot, "workspaces", scopeSpec.workspace_key ?? "");
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

function messagesToConversation(messages: MessageInfo[]): ChatMessage[] {
  const conversation: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      conversation.push({ role: message.role, content: message.content });
    }
  }
  return conversation;
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

function getWorkspaceMemoryKey(workspaceRoot: string | null): string | null {
  if (!workspaceRoot) {
    return null;
  }
  const raw = workspaceRoot.trim();
  if (!raw) {
    return null;
  }
  const normalized = raw
    .replace(/\\/g, "-")
    .replace(/\//g, "-")
    .replace(/:/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return normalized || "workspace";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
