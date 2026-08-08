import { createHash, randomUUID } from "node:crypto";
import type { AgentRunStartResult } from "../../../contracts/execution/execution.js";
import type { ExecutionSessionPort } from "../../../contracts/session/session-application.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import { buildFullSystemPrompt, estimateTokens, resolveToolInstructionMode } from "@ragsystem/agent-sdk";
import { projectAgentProfile } from "../sdk/projection.js";
import type { AgentCompressionService } from "../context-compression/compression-service.js";
import { asString, normalizeSessionEntryAgent } from "./helpers.js";
import { resolveReadyAgent } from "./readiness.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { TenantId } from "../../../identity/types.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { SessionIdentity } from "../../../contracts/session/session.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";

export interface ParsedSlashCommand {
  name: string;
  args: string;
  mode: "system" | "prompt";
  /** Immutable Agent-view text captured at command parse time. */
  agentText: string;
}

interface SystemSlashCommandResult {
  command: string;
  success: boolean;
  content: string;
  error?: string;
  data?: unknown;
}

export interface SlashCommandDispatchResult {
  start: AgentRunStartResult;
  success: boolean;
  content: string;
}

const PROMPT_SLASH_COMMANDS: Record<string, { description: string; template: string }> = {
  review: {
    description: "代码审查",
    template: "请对以下内容进行全面的代码审查，包括代码质量、安全性和性能优化建议：{args}",
  },
  analyze: {
    description: "深度分析",
    template: "请深入分析以下问题，给出详细的技术分析和建议：{args}",
  },
  explain: {
    description: "详细解释",
    template: "请详细解释以下概念或代码，用通俗易懂的方式：{args}",
  },
};

export class SlashCommandHandler {
  constructor(
    private readonly tenantId: TenantId,
    private readonly sessions: ExecutionSessionPort,
    private readonly statusTracker: AgentExecutionStatusTracker,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly providersProvider: () => ModelProviderConfig[],
    private readonly compressionService: AgentCompressionService | null,
    private readonly clientEvents: ClientEventPublisher,
    private readonly runtimeStorage: RuntimeStorage,
  ) {}

  handle(input: {
    sessionId: string;
    sessionIdentity: SessionIdentity;
    userId: string;
    requestId: string;
    selectedLlm: string;
    command: ParsedSlashCommand;
    originalTask: string;
    messageMetadata?: Record<string, unknown>;
    sessionMaintenanceToken?: string;
  }): Promise<SlashCommandDispatchResult | null> {
    if (input.command.mode === "prompt") {
      return Promise.resolve(null);
    }
    return this.executeSystemSlashCommand(input);
  }

  private async executeSystemSlashCommand(input: {
    sessionId: string;
    sessionIdentity: SessionIdentity;
    userId: string;
    requestId: string;
    selectedLlm: string;
    command: ParsedSlashCommand;
    originalTask: string;
    messageMetadata?: Record<string, unknown>;
    sessionMaintenanceToken?: string;
  }): Promise<SlashCommandDispatchResult> {
    if (!(await this.sessions.getSession(input.sessionId))) {
      await this.sessions.createSession({
        tenantId: this.tenantId,
        ...input.sessionIdentity,
      });
    }
    const commandPart = createCommandRefPart(input.command, input.originalTask);
    await this.sessions.addMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.originalTask,
      contentParts: [commandPart],
      metadata: {
        ...(input.messageMetadata ?? {}),
      },
    });
    const result = await this.resolveSystemSlashCommandResult(input);
    const message = await this.sessions.addMessage({
      sessionId: input.sessionId,
      role: "system",
      content: result.content,
      contentParts: [{
        type: "command_result",
        invocation_id: commandPart.invocation_id,
        name: result.command,
        success: result.success,
        text: result.content,
        ...(result.error ? { error: result.error } : {}),
      }],
      metadata: {},
    });
    await this.clientEvents.publish(input.sessionId, {
      type: "state_sync",
      session_id: input.sessionId,
      payload: {
        category: "command_result",
        ref: { message_id: message.id },
        detail: {
          command: result.command,
          invocation_id: commandPart.invocation_id,
          success: result.success,
          content: result.content,
          ...(result.error ? { error: result.error } : {}),
          ...(result.data !== undefined ? { data: result.data } : {}),
        },
      },
    }, {
      aggregateType: "session",
      aggregateId: input.sessionId,
    });
    return {
      start: {
        started: result.success,
        session_id: input.sessionId,
        kind: "command",
      },
      success: result.success,
      content: result.content,
    };
  }

  private async resolveSystemSlashCommandResult(input: {
    sessionId: string;
    requestId: string;
    selectedLlm: string;
    command: ParsedSlashCommand;
    sessionMaintenanceToken?: string;
  }): Promise<SystemSlashCommandResult> {
    if (input.command.name !== "compact") {
      return executeStaticSystemSlashCommand(input.command);
    }
    const runningStatus = this.statusTracker.getStatusBySession(input.sessionId);
    const durableActive = await this.runtimeStorage.operations.getActiveRootRun?.(input.sessionId);
    if (runningStatus?.status === "running" || runningStatus?.status === "pending" || durableActive?.runId) {
      return {
        command: "compact",
        success: false,
        content: "该会话正在执行任务，请等待完成后再压缩",
      };
    }
    const sessionMetadata = (await this.sessions.getSession(input.sessionId))?.metadata ?? {};
    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: normalizeSessionEntryAgent(sessionMetadata.entry_agent),
        teamName: asString(sessionMetadata.team),
        selectedLlm: input.selectedLlm,
      },
      sessionMetadata,
    );
    if (!ready.ok) {
      return {
        command: "compact",
        success: false,
        content: ready.reason,
        error: "runtime_not_ready",
      };
    }
    const maintenanceToken = input.sessionMaintenanceToken ?? randomUUID();
    const ownsMaintenance = input.sessionMaintenanceToken === undefined;
    const maintenanceTtlMs = 60_000;
    const maintenanceReady = ownsMaintenance
      ? (await this.runtimeStorage.operations.claimSessionMaintenance({
          sessionId: input.sessionId,
          token: maintenanceToken,
          kind: "compact",
          ttlMs: maintenanceTtlMs,
        })).claimed
      : await this.runtimeStorage.operations.renewSessionMaintenance({
          sessionId: input.sessionId,
          token: maintenanceToken,
          ttlMs: maintenanceTtlMs,
        });
    if (!maintenanceReady) {
      return {
        command: "compact",
        success: false,
        content: "该会话正在执行任务或维护操作，请稍后再压缩",
      };
    }
    await this.publishRuntimeInvalidation(input.sessionId, "maintenance_claimed");
    let maintenanceLost = false;
    const maintenanceHeartbeat = setInterval(() => {
      void this.runtimeStorage.operations.renewSessionMaintenance({
        sessionId: input.sessionId,
        token: maintenanceToken,
        ttlMs: maintenanceTtlMs,
      }).then((renewed) => {
        if (!renewed) maintenanceLost = true;
      }, () => {
        maintenanceLost = true;
      });
    }, 20_000);
    maintenanceHeartbeat.unref?.();
    try {
      if (!this.compressionService) {
        return { command: "compact", success: false, content: "压缩服务未装配", error: "compression_unavailable" };
      }
      // systemPromptTokens 粗估（仅 base，无 tools/插件注入）；forceCompact 不判阈值，仅影响返回 budgetTokens 展示。
      const compactProfile = projectAgentProfile({ agent: ready.agent, providers: this.providersProvider() });
      const compactMode = resolveToolInstructionMode(compactProfile.llmTiers.default?.provider);
      const systemPromptTokens = estimateTokens(buildFullSystemPrompt(compactProfile, {}, compactMode));
      const result = await this.compressionService.forceCompact({
        agent: ready.agent,
        sessionId: input.sessionId,
        systemPromptTokens,
      });
      if (maintenanceLost || !await this.runtimeStorage.operations.renewSessionMaintenance({
        sessionId: input.sessionId,
        token: maintenanceToken,
        ttlMs: maintenanceTtlMs,
      })) {
        throw new Error("会话维护租约已丢失，压缩结果未继续提交");
      }
      if (result.status === "skipped") {
        if (result.reason === "summary_unavailable") {
          return {
            command: "compact",
            success: false,
            content: "摘要模型不可用，压缩未执行（不做有损截断），请检查 LLM 配置后重试",
            error: "summary_unavailable",
            data: result,
          };
        }
        return {
          command: "compact",
          success: true,
          content: "无需压缩（历史为空或消息不足）",
          data: result,
        };
      }
      await this.sessions.updateSessionMetadata(input.sessionId, {
        _provider_cache: { root: null },
      });
      await this.clientEvents.publish(input.sessionId, {
        type: "state_sync",
        session_id: input.sessionId,
        agent_id: ready.agent.agent_name,
        payload: { category: "compression", detail: { replaced_message_count: result.replacedMessageCount, replaces_up_to_seq: result.replacesUpToSeq } },
      }, {
        aggregateType: "session",
        aggregateId: input.sessionId,
      });
      return {
        command: "compact",
        success: true,
        content: `压缩完成：${result.replacedMessageCount} 条早期消息已压缩为摘要`,
        data: result,
      };
    } catch (error) {
      return {
        command: "compact",
        success: false,
        content: `压缩失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearInterval(maintenanceHeartbeat);
      if (ownsMaintenance) {
        await this.runtimeStorage.operations.releaseSessionMaintenance({
          sessionId: input.sessionId,
          token: maintenanceToken,
        });
        await this.publishRuntimeInvalidation(input.sessionId, "maintenance_released");
      }
    }
  }

  private publishRuntimeInvalidation(sessionId: string, reason: string): Promise<unknown> {
    return this.clientEvents.publish(sessionId, {
      type: "state_sync",
      session_id: sessionId,
      payload: { category: "session_updated", detail: { entity: "session_runtime", reason } },
    }, {
      aggregateType: "session",
      aggregateId: sessionId,
    });
  }
}

export function parseSlashCommand(task: string): ParsedSlashCommand | null {
  const trimmed = task.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [rawCommand = "", ...rest] = trimmed.split(/\s+/);
  const name = rawCommand.slice(1).toLowerCase();
  const args = rest.join(" ").trim();
  if (name === "help" || name === "compact") {
    return { name, args, mode: "system", agentText: "" };
  }
  const promptCommand = PROMPT_SLASH_COMMANDS[name];
  if (!promptCommand) {
    return { name, args, mode: "system", agentText: "" };
  }
  if (!args) {
    return { name, args, mode: "system", agentText: "" };
  }
  return {
    name,
    args,
    mode: "prompt",
    agentText: promptCommand.template.replace("{args}", args),
  };
}

export function createCommandRefPart(
  command: ParsedSlashCommand,
  rawText: string,
  invocationId = `cmd_${randomUUID()}`,
): Extract<MessageContentPart, { type: "command_ref" }> {
  return {
    type: "command_ref",
    invocation_id: invocationId,
    name: command.name || "unknown",
    args: command.args,
    raw_text: rawText,
    resolution: command.mode === "prompt"
      ? {
          kind: "prompt",
          agent_text: command.agentText,
          snapshot_id: `sha256:${createHash("sha256").update(command.agentText).digest("hex")}`,
        }
      : { kind: "system" },
  };
}

function executeStaticSystemSlashCommand(command: ParsedSlashCommand): SystemSlashCommandResult {
  if (command.name === "help") {
    const lines = [
      "可用命令：",
      "",
      "  /help          [系统] 显示可用命令列表",
      "  /compact       [系统] 强制压缩上下文",
      "  /review        [提示词] 代码审查",
      "  /analyze       [提示词] 深度分析",
      "  /explain       [提示词] 详细解释",
      "",
      "提示词命令后跟内容，如: /review 当前仓库代码",
    ];
    return { command: "help", success: true, content: lines.join("\n") };
  }
  const promptCommand = PROMPT_SLASH_COMMANDS[command.name];
  if (promptCommand && !command.args.trim()) {
    return {
      command: command.name,
      success: false,
      content: `用法: /${command.name} <内容>\n${promptCommand.description}`,
      error: "missing_args",
    };
  }
  return {
    command: command.name || "unknown",
    success: false,
    content: `未知命令: /${command.name}\n输入 /help 查看可用命令`,
    error: "unknown_command",
  };
}
