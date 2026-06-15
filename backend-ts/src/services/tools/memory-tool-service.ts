import type { AgentConfig } from "../../contracts/agent-config.js";
import type { SessionInfo } from "../../contracts/session.js";
import type { ToolExecutionResult } from "../runtime/runtime-tool-types.js";
import { getWorkspaceMemoryKey, type MemoryScopeName, type MemoryScopeSpec, type MemoryStore } from "../stores/memory-store.js";

export interface RuntimeMemorySessionPort {
  getSession(sessionId: string): Pick<SessionInfo, "metadata"> | null;
}

export interface MemoryToolRuntimeContext {
  agent: AgentConfig | null;
  sessionId?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
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

interface ResolvedMemoryScopeInputs {
  scopeSpec: MemoryScopeSpec;
  currentAgentName: string | null;
}

export class MemoryToolService {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly sessions: RuntimeMemorySessionPort,
  ) {}

  listMemoryIndex(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
  ): ToolExecutionResult<string> {
    const toolName = "list_memory_index";
    const setup = this.resolveReadableScope(input, context, toolName);
    if ("error" in setup) {
      return errorResult(setup.error, toolName);
    }

    const content = this.memoryStore.loadIndexHead(setup.scopeSpec);
    return successResult(content, {
      summary: `已读取 ${setup.scopeSpec.scope} MEMORY 索引`,
      outputType: "text",
      metadata: {
        scope: setup.scopeSpec.scope,
        index_file_path: this.memoryStore.getIndexPath(setup.scopeSpec),
      },
      toolName,
    });
  }

  readMemoryEntry(
    input: ReadMemoryEntryInput,
    context: MemoryToolRuntimeContext,
  ): ToolExecutionResult<string> {
    const toolName = "read_memory_entry";
    const setup = this.resolveReadableScope(input, context, toolName);
    if ("error" in setup) {
      return errorResult(setup.error, toolName);
    }

    const entry = this.memoryStore.readEntryFile(setup.scopeSpec, input.fileName);
    if (!entry) {
      return errorResult(`memory 文件不存在: ${input.fileName}`, toolName);
    }
    return successResult(entry.content, {
      summary: `已读取记忆文件: ${entry.file_name}`,
      outputType: "text",
      metadata: {
        file_path: entry.file_path,
        scope: entry.scope,
      },
      toolName,
    });
  }

  writeMemory(
    input: WriteMemoryInput,
    context: MemoryToolRuntimeContext,
  ): ToolExecutionResult<{ file_path: string; file_name: string; scope: string } | string> {
    const toolName = "write_memory";
    const setup = this.resolveMemoryScope(input, context, toolName, "write");
    if ("error" in setup) {
      return errorResult(setup.error, toolName);
    }

    try {
      const saved = this.memoryStore.saveMemory({
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
      return successResult(
        {
          file_path: saved.file_path,
          file_name: saved.file_name,
          scope: saved.scope,
        },
        {
          summary: `已写入 ${saved.scope} memory: ${saved.file_name}`,
          outputType: "json",
          metadata: {
            file_path: saved.file_path,
            scope: saved.scope,
          },
          toolName,
        },
      );
    } catch (error) {
      return errorResult(`写入 memory 失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  archiveMemory(
    input: ArchiveMemoryInput,
    context: MemoryToolRuntimeContext,
  ): ToolExecutionResult<{ archived: boolean; file_name: string; scope: string } | string> {
    const toolName = "archive_memory";
    const setup = this.resolveMemoryScope(input, context, toolName, "archive");
    if ("error" in setup) {
      return errorResult(setup.error, toolName);
    }

    try {
      const archived = this.memoryStore.archiveMemory(setup.scopeSpec, input.fileName);
      if (!archived) {
        return errorResult(
          `未找到可归档的 memory: ${input.fileName}。请先通过 list_memory_index 确认当前 scope 下的真实文件名。`,
          toolName,
        );
      }
      return successResult(
        {
          archived: true,
          file_name: input.fileName,
          scope: setup.scopeSpec.scope,
        },
        {
          summary: `已归档 ${setup.scopeSpec.scope} memory: ${input.fileName}`,
          outputType: "json",
          metadata: {
            file_name: input.fileName,
            scope: setup.scopeSpec.scope,
          },
          toolName,
        },
      );
    } catch (error) {
      return errorResult(`归档 memory 失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  private resolveReadableScope(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    toolName: string,
  ): { error: string } | ResolvedMemoryScopeInputs {
    return this.resolveMemoryScope(input, context, toolName, "read");
  }

  private resolveMemoryScope(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    toolName: string,
    mode: "read" | "write" | "archive",
  ): { error: string } | ResolvedMemoryScopeInputs {
    const memoryConfig = context.agent?.memory;
    const currentAgentName = normalizeString(input.currentAgentName) ?? normalizeString(context.currentAgentName) ?? context.agent?.agent_name ?? null;
    if (!memoryConfig || !hasMemoryCapability(memoryConfig)) {
      return { error: `当前 Agent 未启用 memory 能力: ${currentAgentName ?? "unknown"}` };
    }

    const normalizedScope = normalizeMemoryScope(input.scope);
    if (!normalizedScope) {
      return { error: `不支持的 memory scope: ${input.scope}` };
    }
    const allowedScopes = new Set((memoryConfig.allowed_scopes?.length ? memoryConfig.allowed_scopes : ["team", "session"]).map((item) => item.toLowerCase()));
    if (!allowedScopes.has(normalizedScope)) {
      return { error: `当前 Agent 不允许访问 memory scope: ${input.scope}` };
    }
    if (mode === "write") {
      const writeScopes = new Set((memoryConfig.write_scopes ?? []).map((item) => item.toLowerCase()));
      if (!writeScopes.has(normalizedScope)) {
        return { error: `当前 Agent 不允许写入 memory scope: ${input.scope}` };
      }
    }
    if (mode === "archive") {
      const archiveScopes = new Set((memoryConfig.archive_scopes ?? []).map((item) => item.toLowerCase()));
      if (!archiveScopes.has(normalizedScope)) {
        return { error: `当前 Agent 不允许归档 memory scope: ${input.scope}` };
      }
    }

    const scopeSpec = this.resolveScopeSpec(input, context, normalizedScope, currentAgentName);
    if ("error" in scopeSpec) {
      return { error: `${toolName} 缺少 ${scopeSpec.error}` };
    }
    return {
      scopeSpec,
      currentAgentName,
    };
  }

  private resolveScopeSpec(
    input: ListMemoryIndexInput,
    context: MemoryToolRuntimeContext,
    scope: MemoryScopeName,
    currentAgentName: string | null,
  ): MemoryScopeSpec | { error: string } {
    const sessionId = normalizeString(input.sessionId) ?? normalizeString(context.sessionId);
    const sessionMetadata = sessionId ? (this.sessions.getSession(sessionId)?.metadata ?? {}) : {};
    const teamName = normalizeString(input.teamName) ?? normalizeString(context.teamName) ?? normalizeString(sessionMetadata.team);
    const workspaceRoot =
      normalizeString(input.workspaceRoot) ?? normalizeString(context.workspaceRoot) ?? normalizeString(sessionMetadata.workspace_root);

    if (scope === "team") {
      return teamName ? { scope, team_name: teamName } : { error: "team_name" };
    }
    if (scope === "session") {
      return sessionId ? { scope, session_id: sessionId } : { error: "session_id" };
    }
    if (scope === "agent") {
      const agentName = normalizeString(input.agentName) ?? currentAgentName;
      if (!teamName) {
        return { error: "team_name" };
      }
      return agentName ? { scope, agent_name: agentName, team_name: teamName } : { error: "agent_name" };
    }
    const workspaceKey = normalizeString(input.workspaceKey) ?? getWorkspaceMemoryKey(workspaceRoot);
    return workspaceKey ? { scope, workspace_key: workspaceKey } : { error: "workspace_key" };
  }
}

function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
    toolName: string;
  },
): ToolExecutionResult<T> {
  return {
    success: true,
    tool_name: input.toolName,
    summary: input.summary,
    answer: null,
    output_type: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llm_hint: null,
  };
}

function errorResult(message: string, toolName: string): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
    },
    artifacts: [],
    llm_hint: null,
  };
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
  if (normalized === "team" || normalized === "session" || normalized === "agent" || normalized === "workspace") {
    return normalized;
  }
  return null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
