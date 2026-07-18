import type { ToolAccessDecision, ToolExecutionResult } from "@ragsystem/agent-sdk";

import {
  getWorkspaceMemoryKey,
  type MemoryScopeName,
  type MemoryScopeSpec,
} from "../../contracts/memory-store/index.js";
import type { MemoryApplication, MemoryScopePartition } from "../../services/memory/index.js";
import { toMemoryScopePartition } from "../../services/memory/scope-partition.js";
import { toolError, toolSuccess } from "../../services/agent/sdk/tool-results.js";
import { normalizeString } from "../../utils/guards.js";
import type {
  ArchiveMemoryInput,
  ListMemoryIndexInput,
  MemoryToolOperations,
  MemoryToolRuntimeContext,
  ReadMemoryEntryInput,
  RuntimeMemorySessionPort,
  WriteMemoryInput,
} from "./MemoryExecution.js";

interface ResolvedSaaSMemoryScope {
  partition: MemoryScopePartition;
}

/** Memory tool operations backed by the tenant-bound SaaS application facade. */
export class SaaSMemoryToolService implements MemoryToolOperations {
  constructor(
    private readonly memory: MemoryApplication,
    private readonly sessions: RuntimeMemorySessionPort,
  ) {}

  checkMemoryScopeAccess(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    mode: "read" | "write" | "archive",
  ): ToolAccessDecision {
    const memoryConfig = context.agent?.memory;
    if (!memoryConfig || !hasMemoryCapability(memoryConfig)) {
      return { action: "deny", reason: "当前 Agent 未启用 memory 能力" };
    }
    const scope = normalizeMemoryScope(input.scope);
    if (!scope) return { action: "deny", reason: `不支持的 memory scope: ${input.scope}` };
    const allowed = new Set((memoryConfig.allowed_scopes?.length ? memoryConfig.allowed_scopes : ["team", "session"]).map(lower));
    if (!allowed.has(scope)) return { action: "deny", reason: `当前 Agent 不允许访问 memory scope: ${input.scope}` };
    if (mode === "write" && !new Set((memoryConfig.write_scopes ?? []).map(lower)).has(scope)) {
      return { action: "deny", reason: `当前 Agent 不允许写入 memory scope: ${input.scope}` };
    }
    if (mode === "archive") {
      if (!normalizeString(context.userId)) {
        return { action: "deny", reason: "当前执行缺少用户身份，无法提交 memory 归档申请" };
      }
      if (!new Set((memoryConfig.archive_scopes ?? []).map(lower)).has(scope)) {
        return { action: "deny", reason: `当前 Agent 不允许归档 memory scope: ${input.scope}` };
      }
    }
    return { action: "allow" };
  }

  async listMemoryIndex(input: ListMemoryIndexInput, context: MemoryToolRuntimeContext): Promise<ToolExecutionResult> {
    const toolName = "list_memory_index";
    const setup = this.resolveScope(input, context, toolName);
    if ("error" in setup) return toolError(toolName, setup.error);
    try {
      const entries = await this.memory.query.listEntries(setup.partition);
      const content = entries.length === 0
        ? "# Memory\n\nNo active memory entries."
        : `# Memory\n\n${entries.map((entry) => `- [${entry.name}](${entry.id}) - ${entry.description}`).join("\n")}`;
      return toolSuccess(content, {
        toolName,
        summary: `已读取 ${setup.partition.scope} memory 索引`,
        outputType: "text",
        metadata: { scope: setup.partition.scope },
      });
    } catch (error) {
      return toolError(toolName, `读取 memory 索引失败: ${errorMessage(error)}`);
    }
  }

  async readMemoryEntry(input: ReadMemoryEntryInput, context: MemoryToolRuntimeContext): Promise<ToolExecutionResult> {
    const toolName = "read_memory_entry";
    const setup = this.resolveScope(input, context, toolName);
    if ("error" in setup) return toolError(toolName, setup.error);
    try {
      // fileName remains accepted as the transport field while SaaS treats it as a stable memory id.
      const entry = await this.memory.query.getEntry(input.fileName);
      if (!entry || entry.status !== "active" || entry.scope !== setup.partition.scope || entry.scope_id !== setup.partition.scope_id) {
        return toolError(toolName, `memory 不存在: ${input.fileName}`);
      }
      return toolSuccess(renderEntry(entry), {
        toolName,
        summary: `已读取记忆: ${entry.name}`,
        outputType: "text",
        metadata: { memory_id: entry.id, scope: entry.scope },
      });
    } catch (error) {
      return toolError(toolName, `读取 memory 失败: ${errorMessage(error)}`);
    }
  }

  async writeMemory(input: WriteMemoryInput, context: MemoryToolRuntimeContext): Promise<ToolExecutionResult> {
    const toolName = "write_memory";
    const setup = this.resolveScope(input, context, toolName);
    if ("error" in setup) return toolError(toolName, setup.error);
    const ownerUserId = normalizeString(context.userId);
    if (!ownerUserId) return toolError(toolName, "当前执行缺少用户身份，无法保存 memory");
    try {
      const candidate = await this.memory.commands.createCandidate({
        ...setup.partition,
        operation: "publish",
        owner_user_id: ownerUserId,
        name: input.name,
        description: input.description,
        memory_type: input.memoryType,
        content: input.content,
        ...(input.why !== undefined ? { why: input.why } : {}),
        ...(input.howToApply !== undefined ? { how_to_apply: input.howToApply } : {}),
        ...(normalizeString(context.sessionId) ? { source_session_id: normalizeString(context.sessionId) } : {}),
        ...(input.sourceRunId ?? normalizeString(context.runId) ? { source_run_id: input.sourceRunId ?? normalizeString(context.runId) } : {}),
        ...(input.sourceMessageId !== undefined ? { source_message_id: input.sourceMessageId } : {}),
      });
      return toolSuccess({ saved: true, candidate_id: candidate.id, scope: setup.partition.scope }, {
        toolName,
        summary: `已提交 ${setup.partition.scope} memory 候选`,
        outputType: "json",
        metadata: { candidate_id: candidate.id, scope: setup.partition.scope },
      });
    } catch (error) {
      return toolError(toolName, `写入 memory 失败: ${errorMessage(error)}`);
    }
  }

  async archiveMemory(input: ArchiveMemoryInput, context: MemoryToolRuntimeContext): Promise<ToolExecutionResult> {
    const toolName = "archive_memory";
    const setup = this.resolveScope(input, context, toolName);
    if ("error" in setup) return toolError(toolName, setup.error);
    const ownerUserId = normalizeString(context.userId);
    if (!ownerUserId) return toolError(toolName, "当前执行缺少用户身份，无法提交 memory 归档申请");
    try {
      const entry = await this.memory.query.getEntry(input.fileName);
      if (!entry || entry.status !== "active" || entry.scope !== setup.partition.scope || entry.scope_id !== setup.partition.scope_id) {
        return toolError(toolName, `未找到可归档的 memory: ${input.fileName}`);
      }
      const candidate = await this.memory.commands.createCandidate({
        ...setup.partition,
        operation: "archive",
        owner_user_id: ownerUserId,
        target_memory_id: entry.id,
        ...(normalizeString(context.sessionId) ? { source_session_id: normalizeString(context.sessionId) } : {}),
        ...(normalizeString(context.runId) ? { source_run_id: normalizeString(context.runId) } : {}),
      });
      return toolSuccess({ saved: true, candidate_id: candidate.id, memory_id: entry.id, scope: entry.scope }, {
        toolName,
        summary: `已提交 ${entry.scope} memory 归档申请`,
        outputType: "json",
        metadata: { candidate_id: candidate.id, memory_id: entry.id, scope: entry.scope, operation: "archive" },
      });
    } catch (error) {
      return toolError(toolName, `归档 memory 失败: ${errorMessage(error)}`);
    }
  }

  private resolveScope(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    toolName: string,
  ): ResolvedSaaSMemoryScope | { error: string } {
    const scope = normalizeMemoryScope(input.scope);
    if (!scope) return { error: `不支持的 memory scope: ${input.scope}` };
    const sessionId = normalizeString(context.sessionId);
    const metadata = sessionId ? this.sessions.getSession(sessionId)?.metadata ?? {} : {};
    const teamName = normalizeString(context.teamName) ?? normalizeString(metadata.team);
    const userId = normalizeString(context.userId);
    const agentName = normalizeString(input.currentAgentName) ?? normalizeString(context.currentAgentName) ?? context.agent?.agent_name ?? null;
    const workspaceRoot = normalizeString(context.workspaceRoot) ?? normalizeString(metadata.workspace_root);

    let scopeSpec: MemoryScopeSpec | null = null;
    let missing: string;
    if (scope === "team") {
      scopeSpec = teamName ? { scope, team_name: teamName } : null;
      missing = "team_name";
    } else if (scope === "session") {
      scopeSpec = sessionId ? { scope, session_id: sessionId } : null;
      missing = "session_id";
    } else if (scope === "agent") {
      scopeSpec = teamName && agentName ? { scope, team_name: teamName, agent_name: agentName } : null;
      missing = teamName ? "agent_name" : "team_name";
    } else if (scope === "user") {
      scopeSpec = userId ? { scope, user_id: userId } : null;
      missing = "user_id";
    } else {
      const workspaceKey = normalizeString(input.workspaceKey) ?? getWorkspaceMemoryKey(workspaceRoot);
      scopeSpec = userId && workspaceKey ? { scope, user_id: userId, workspace_key: workspaceKey } : null;
      missing = userId ? "workspace_key" : "user_id";
    }
    const partition = scopeSpec ? toMemoryScopePartition(scopeSpec) : null;
    return partition ? { partition } : { error: `${toolName} 缺少 ${missing}` };
  }
}

function normalizeMemoryScope(value: string): MemoryScopeName | null {
  const scope = value.trim().toLowerCase();
  return scope === "team" || scope === "session" || scope === "agent" || scope === "workspace" || scope === "user" ? scope : null;
}

function lower(value: string): string { return value.toLowerCase(); }
function hasMemoryCapability(memory: NonNullable<MemoryToolRuntimeContext["agent"]>["memory"]): boolean {
  return Boolean(memory.allowed_scopes?.length || memory.write_scopes?.length || memory.archive_scopes?.length);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function renderEntry(entry: Awaited<ReturnType<MemoryApplication["query"]["getEntry"]>> & {}): string {
  if (!entry) return "";
  const sections = [`# ${entry.name}`, entry.content];
  if (entry.why) sections.push(`## Why\n\n${entry.why}`);
  if (entry.how_to_apply) sections.push(`## How to apply\n\n${entry.how_to_apply}`);
  return sections.join("\n\n");
}
