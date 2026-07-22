import { normalizeString } from "../../utils/guards.js";
import type { AgentConfig } from "../../contracts/agent/agent-config.js";
import type { SessionInfo } from "../../contracts/session/session.js";
import type { ToolAccessDecision, ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "../../services/agent/sdk/tool-results.js";
import {
  getWorkspaceMemoryKey,
  type MemoryCandidateCommandPort,
  type MemoryToolRepositoryPort,
  type MemoryScopeName,
  type MemoryScopeSpec,
} from "../../contracts/memory-store/index.js";

export interface RuntimeMemorySessionPort {
  getSession(sessionId: string): Promise<Pick<SessionInfo, "metadata"> & Partial<Pick<SessionInfo, "user_id">> | null>;
}

export interface MemoryToolRuntimeContext {
  agent: AgentConfig | null;
  sessionId?: string | null | undefined;
  currentAgentName?: string | null | undefined;
  teamName?: string | null | undefined;
  workspaceRoot?: string | null | undefined;
  userId?: string | null | undefined;
  runId?: string | null | undefined;
}

export interface ListMemoryIndexInput {
  scope: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
}

export interface ReadMemoryEntryInput extends ListMemoryIndexInput {
  fileName: string;
}

export interface WriteMemoryInput extends ListMemoryIndexInput {
  name: string;
  description: string;
  memoryType: string;
  content: string;
  why?: string | null;
  howToApply?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
}

export interface ArchiveMemoryInput extends ListMemoryIndexInput {
  fileName: string;
}

export interface MemoryToolOperations {
  checkMemoryScopeAccess(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    mode: "read" | "write" | "archive",
  ): ToolAccessDecision;
  listMemoryIndex(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
  ): Promise<ToolExecutionResult>;
  readMemoryEntry(
    input: ReadMemoryEntryInput,
    context: MemoryToolRuntimeContext,
  ): Promise<ToolExecutionResult>;
  writeMemory(input: WriteMemoryInput, context: MemoryToolRuntimeContext): Promise<ToolExecutionResult>;
  archiveMemory(input: ArchiveMemoryInput, context: MemoryToolRuntimeContext): Promise<ToolExecutionResult>;
}

interface ResolvedMemoryScopeInputs {
  scopeSpec: MemoryScopeSpec;
  currentAgentName: string | null;
}

export class MemoryToolService implements MemoryToolOperations {
  constructor(
    private readonly memoryStore: MemoryToolRepositoryPort,
    private readonly sessions: RuntimeMemorySessionPort,
    private readonly candidates?: MemoryCandidateCommandPort,
    private readonly tenantId?: string,
  ) {}

  /**
   * memory scope 访问检查（工具 checkAccess 用）：scope 合法性 + allowed/write/archive 白名单。
   * 越权 → deny（reason 引导换 scope）；通过 → allow。call 内 resolveMemoryScope 只做定位。
   */
  checkMemoryScopeAccess(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    mode: "read" | "write" | "archive",
  ): ToolAccessDecision {
    const memoryConfig = context.agent?.memory;
    if (!memoryConfig || !hasMemoryCapability(memoryConfig)) {
      return { action: "deny", reason: "当前 Agent 未启用 memory 能力" };
    }
    const normalizedScope = normalizeMemoryScope(input.scope);
    if (!normalizedScope) {
      return { action: "deny", reason: `不支持的 memory scope: ${input.scope}` };
    }
    const allowedScopes = new Set((memoryConfig.allowed_scopes?.length ? memoryConfig.allowed_scopes : ["team", "session"]).map((item) => item.toLowerCase()));
    if (!allowedScopes.has(normalizedScope)) {
      return { action: "deny", reason: `当前 Agent 不允许访问 memory scope: ${input.scope}` };
    }
    if (mode === "write") {
      const writeScopes = new Set((memoryConfig.write_scopes ?? []).map((item) => item.toLowerCase()));
      if (!writeScopes.has(normalizedScope)) {
        return { action: "deny", reason: `当前 Agent 不允许写入 memory scope: ${input.scope}` };
      }
    }
    if (mode === "archive") {
      if (normalizedScope === "team" || normalizedScope === "agent") {
        const ownerUserId = normalizeString(context.userId);
        if (!ownerUserId || !this.candidates || !this.tenantId) {
          return { action: "deny", reason: "当前执行缺少用户身份，无法提交共享 memory 归档申请" };
        }
        return { action: "allow" };
      }
      const archiveScopes = new Set((memoryConfig.archive_scopes ?? []).map((item) => item.toLowerCase()));
      if (!archiveScopes.has(normalizedScope)) {
        return { action: "deny", reason: `当前 Agent 不允许归档 memory scope: ${input.scope}` };
      }
    }
    return { action: "allow" };
  }

  async listMemoryIndex(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
  ): Promise<ToolExecutionResult> {
    const toolName = "list_memory_index";
    const setup = await this.resolveReadableScope(input, context, toolName);
    if ("error" in setup) {
      return toolError(toolName, setup.error);
    }

    const content = await this.memoryStore.loadIndexHead(setup.scopeSpec);
    const indexPath = await this.memoryStore.getIndexPath?.(setup.scopeSpec);
    return toolSuccess(content, {
      toolName,
      summary: `已读取 ${setup.scopeSpec.scope} MEMORY 索引`,
      outputType: "text",
      metadata: {
        scope: setup.scopeSpec.scope,
        ...(indexPath ? { index_file_path: indexPath } : {}),
      },
    });
  }

  async readMemoryEntry(
    input: ReadMemoryEntryInput,
    context: MemoryToolRuntimeContext,
  ): Promise<ToolExecutionResult> {
    const toolName = "read_memory_entry";
    const setup = await this.resolveReadableScope(input, context, toolName);
    if ("error" in setup) {
      return toolError(toolName, setup.error);
    }

    const entry = await this.memoryStore.readEntryFile(setup.scopeSpec, input.fileName);
    if (!entry) {
      return toolError(toolName, `memory 文件不存在: ${input.fileName}`);
    }
    return toolSuccess(entry.content, {
      toolName,
      summary: `已读取记忆文件: ${entry.file_name}`,
      outputType: "text",
      metadata: {
        file_path: entry.file_path,
        scope: entry.scope,
      },
    });
  }

  async writeMemory(
    input: WriteMemoryInput,
    context: MemoryToolRuntimeContext,
  ): Promise<ToolExecutionResult> {
    const toolName = "write_memory";
    const setup = await this.resolveMemoryScope(input, context, toolName);
    if ("error" in setup) {
      return toolError(toolName, setup.error);
    }

    try {
      if (setup.scopeSpec.scope === "team" || setup.scopeSpec.scope === "agent") {
        const ownerUserId = normalizeString(context.userId);
        if (!ownerUserId || !this.candidates || !this.tenantId) {
          return toolError(toolName, "当前执行缺少用户身份，无法保存共享范围 memory");
        }
        await this.candidates.createMemoryCandidate({
          tenantId: this.tenantId,
          ownerUserId,
          targetScope: setup.scopeSpec.scope,
          teamName: setup.scopeSpec.team_name!,
          agentName: setup.scopeSpec.scope === "agent" ? setup.scopeSpec.agent_name ?? null : null,
          name: input.name,
          description: input.description,
          memoryType: input.memoryType,
          content: input.content,
          ...(input.why !== undefined ? { why: input.why } : {}),
          ...(input.howToApply !== undefined ? { howToApply: input.howToApply } : {}),
          sourceSessionId: normalizeString(context.sessionId),
          sourceRunId: input.sourceRunId ?? normalizeString(context.runId),
          ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
        });
        return toolSuccess(
          { saved: true, scope: setup.scopeSpec.scope },
          {
            toolName,
            summary: `已保存 ${setup.scopeSpec.scope} memory`,
            outputType: "json",
            metadata: { scope: setup.scopeSpec.scope },
          },
        );
      }
        const saved = await this.memoryStore.saveMemory({
        ...setup.scopeSpec,
        name: input.name,
        description: input.description,
        memory_type: input.memoryType,
        content: input.content,
        why: input.why,
        how_to_apply: input.howToApply,
        source_run_id: input.sourceRunId,
        source_message_id: input.sourceMessageId,
      });
      return toolSuccess(
        {
          file_path: saved.file_path,
          file_name: saved.file_name,
          scope: saved.scope,
        },
        {
          toolName,
          summary: `已写入 ${saved.scope} memory: ${saved.file_name}`,
          outputType: "json",
          metadata: {
            file_path: saved.file_path,
            scope: saved.scope,
          },
        },
      );
    } catch (error) {
      return toolError(toolName, `写入 memory 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async archiveMemory(
    input: ArchiveMemoryInput,
    context: MemoryToolRuntimeContext,
  ): Promise<ToolExecutionResult> {
    const toolName = "archive_memory";
    const setup = await this.resolveMemoryScope(input, context, toolName);
    if ("error" in setup) {
      return toolError(toolName, setup.error);
    }

    try {
      if (setup.scopeSpec.scope === "team" || setup.scopeSpec.scope === "agent") {
        const ownerUserId = normalizeString(context.userId);
        if (!ownerUserId || !this.candidates || !this.tenantId) {
          return toolError(toolName, "当前执行缺少用户身份，无法提交共享范围 memory 归档申请");
        }
        await this.candidates.createMemoryCandidate({
          tenantId: this.tenantId,
          ownerUserId,
          targetScope: setup.scopeSpec.scope,
          operation: "archive",
          targetFileName: input.fileName,
          teamName: setup.scopeSpec.team_name!,
          agentName: setup.scopeSpec.scope === "agent" ? setup.scopeSpec.agent_name ?? null : null,
          name: `Archive ${input.fileName}`,
          description: `请求归档 ${input.fileName}`,
          memoryType: "constraint",
          content: "",
          sourceSessionId: normalizeString(context.sessionId),
          sourceRunId: normalizeString(context.runId),
        });
        return toolSuccess({ saved: true, scope: setup.scopeSpec.scope }, {
          toolName,
          summary: `已提交 ${setup.scopeSpec.scope} memory 归档申请`,
          outputType: "json",
          metadata: { scope: setup.scopeSpec.scope, operation: "archive" },
        });
      }
      const archived = await this.memoryStore.archiveMemory(setup.scopeSpec, input.fileName);
      if (!archived) {
        return toolError(
          toolName,
          `未找到可归档的 memory: ${input.fileName}。请先通过 list_memory_index 确认当前 scope 下的真实文件名。`,
        );
      }
      return toolSuccess(
        {
          archived: true,
          file_name: input.fileName,
          scope: setup.scopeSpec.scope,
        },
        {
          toolName,
          summary: `已归档 ${setup.scopeSpec.scope} memory: ${input.fileName}`,
          outputType: "json",
          metadata: {
            file_name: input.fileName,
            scope: setup.scopeSpec.scope,
          },
        },
      );
    } catch (error) {
      return toolError(toolName, `归档 memory 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async resolveReadableScope(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    toolName: string,
  ): Promise<{ error: string } | ResolvedMemoryScopeInputs> {
    return this.resolveMemoryScope(input, context, toolName);
  }

  /**
   * 定位 memory scope（call 用）：normalizeMemoryScope + resolveScopeSpec。
   * scope 白名单校验（allowed/write/archive）已移 checkMemoryScopeAccess（checkAccess 阶段 deny）。
   */
  private async resolveMemoryScope(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    toolName: string,
  ): Promise<{ error: string } | ResolvedMemoryScopeInputs> {
    const currentAgentName = normalizeString(input.currentAgentName) ?? normalizeString(context.currentAgentName) ?? context.agent?.agent_name ?? null;
    const normalizedScope = normalizeMemoryScope(input.scope);
    if (!normalizedScope) {
      return { error: `不支持的 memory scope: ${input.scope}` };
    }
    const scopeSpec = await this.resolveScopeSpec(input, context, normalizedScope, currentAgentName);
    if ("error" in scopeSpec) {
      return { error: `${toolName} 缺少 ${scopeSpec.error}` };
    }
    return {
      scopeSpec,
      currentAgentName,
    };
  }

  private async resolveScopeSpec(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    scope: MemoryScopeName,
    currentAgentName: string | null,
  ): Promise<MemoryScopeSpec | { error: string }> {
    const sessionId = normalizeString(context.sessionId);
    const sessionMetadata = sessionId ? ((await this.sessions.getSession(sessionId))?.metadata ?? {}) : {};
    const teamName = normalizeString(context.teamName) ?? normalizeString(sessionMetadata.team);
    const workspaceRoot =
      normalizeString(context.workspaceRoot) ?? normalizeString(sessionMetadata.workspace_root);

    if (scope === "team") {
      return teamName ? { scope, team_name: teamName } : { error: "team_name" };
    }
    if (scope === "session") {
      return sessionId ? { scope, session_id: sessionId } : { error: "session_id" };
    }
    if (scope === "agent") {
      const agentName = currentAgentName;
      if (!teamName) {
        return { error: "team_name" };
      }
      return agentName ? { scope, agent_name: agentName, team_name: teamName } : { error: "agent_name" };
    }
    if (scope === "user") {
      const userId = normalizeString(context.userId);
      return userId ? { scope, user_id: userId } : { error: "user_id" };
    }
    const workspaceKey = getWorkspaceMemoryKey(workspaceRoot);
    const userId = normalizeString(context.userId);
    if (!userId) return { error: "user_id" };
    return workspaceKey ? { scope, workspace_key: workspaceKey, user_id: userId } : { error: "workspace_key" };
  }
}

function hasMemoryCapability(memoryConfig: AgentConfig["memory"]): boolean {
  return Boolean(
    memoryConfig.allowed_scopes?.length ||
      memoryConfig.write_scopes?.length ||
      memoryConfig.archive_scopes?.length,
  );
}

function normalizeMemoryScope(value: string): MemoryScopeName | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "team" || normalized === "session" || normalized === "agent" || normalized === "workspace" || normalized === "user") {
    return normalized;
  }
  return null;
}
