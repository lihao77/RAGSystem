import { createHash, randomUUID } from "node:crypto";
import type { AgentRunStartResult } from "../../../contracts/execution/execution.js";
import type { ExecutionSessionPort } from "../../../contracts/session/session-application.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import { buildFullSystemPrompt, estimateTokens, resolveToolInstructionMode } from "@ragsystem/agent-sdk";
import { projectAgentProfile } from "../sdk/projection.js";
import type { AgentCompressionService } from "../context-compression/compression-service.js";
import { resolveReadyAgent } from "./readiness.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { TenantId } from "../../../identity/types.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import { requireSessionTeamSnapshot, type SessionIdentity } from "../../../contracts/session/session.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import { partsToPlainText } from "@ragsystem/agent-protocol";

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
  contentParts: MessageContentPart[];
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
    // 系统命令 echo 行经统一闸门（appendMailboxMessage）：与用户首发同载体——
    // mailbox 信封同事务派生会话消息行并 settle，留审计痕。行 id
    // slashcmd_<invocation_id>，invocation_id 每次派发生成（客户端重试同一命令
    // 产生新 echo 行，与旧行为一致）；幂等只覆盖同一 invocation 的重复派发。
    // 会话行不存在时由闸门同事务创建。
    const commandPart = createCommandRefPart(input.command, input.originalTask);
    const appendResult = await this.runtimeStorage.operations.appendMailboxMessage({
      session: input.sessionIdentity,
      mailboxMessage: {
        messageId: `slashcmd_${commandPart.invocation_id}`,
        tenantId: this.tenantId,
        sessionId: input.sessionId,
        targetThreadKey: "root",
        kind: "request",
        inputType: "user_message",
        sourceKind: "user",
        visibleToUser: true,
        sentAt: new Date().toISOString(),
        contentParts: [commandPart],
        metadata: {
          ...(input.messageMetadata ?? {}),
        },
      },
    });
    const savedUserMessage = appendResult.message;
    await this.clientEvents.publish(input.sessionId, {
      type: "state_sync",
      session_id: input.sessionId,
      payload: {
        category: "message_saved",
        ref: {
          message_id: savedUserMessage.id,
          seq: savedUserMessage.seq,
          role: savedUserMessage.role,
          request_id: input.requestId,
          content_parts: savedUserMessage.content_parts,
        },
      },
    }, {
      aggregateType: "session",
      aggregateId: input.sessionId,
    });
    const result = await this.resolveSystemSlashCommandResult(input);
    const resultPart: Extract<MessageContentPart, { type: "command_result" }> = {
      type: "command_result",
      invocation_id: commandPart.invocation_id,
      name: result.command,
      success: result.success,
      text: result.content,
      ...(result.error ? { error: result.error } : {}),
    };
    const message = await this.sessions.addMessage({
      sessionId: input.sessionId,
      role: "system",
      contentParts: [resultPart],
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
      contentParts: [resultPart],
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
    const session = await this.sessions.getSession(input.sessionId);
    if (!session) {
      return {
        command: "compact",
        success: false,
        content: "会话不存在",
        error: "session_not_found",
      };
    }
    const teamSnapshot = requireSessionTeamSnapshot(session);
    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: teamSnapshot.entry_agent_name,
        teamSnapshot,
        selectedLlm: input.selectedLlm,
      },
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
    // 与 run 相同的中断通道：手动 /compact 进行中可被 stopSession 中止（用户视角统一
    // "指令可打断"）。signal 传给 forceCompact → 摘要 LLM 请求，abort 在传输层掐断 HTTP。
    const compactAbort = new AbortController();
    this.statusTracker.registerMaintenanceAbort(input.sessionId, compactAbort);
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
    // "压缩中"客户端帧：forceCompact 调摘要 LLM 可能数十秒，先亮前端呼吸点；收尾帧兜底清除。
    // forced: true 标记手动路径——前端据此区分终态（手动由 command_result 结果行接管，
    // "压缩完成：N 条"）；横线本身自动/手动都挂（前端 reducer 不再看 forced）。
    // started/finished 是瞬态帧（与 run 内自动压缩的 runtime-adapter 口径一致）：不落
    // outbox、不进重连回放——刷新恢复由 maintenance·compact 租约派生承担，崩溃时也不留
    // 孤儿 durable 行；无实时通道时降级 durable publish，宁可落库不静默丢帧。
    // 定义在 try 外：catch（用户停止/失败）同样要发 finished 收尾帧。
    const publishCompressionState = (detail: Record<string, unknown>): Promise<unknown> => {
      const envelope = {
        type: "state_sync" as const,
        session_id: input.sessionId,
        payload: { category: "compression", detail: { ...detail, forced: true, thread_key: "root" } },
      };
      return this.clientEvents.publishEphemeral?.(input.sessionId, envelope)
        ?? this.clientEvents.publish(input.sessionId, envelope, {
          aggregateType: "session",
          aggregateId: input.sessionId,
        });
    };
    try {
      if (!this.compressionService) {
        return { command: "compact", success: false, content: "压缩服务未装配", error: "compression_unavailable" };
      }
      // systemPromptTokens 粗估（仅 base，无 tools/插件注入）；forceCompact 不判阈值，仅影响返回 budgetTokens 展示。
      const compactProfile = projectAgentProfile({ agent: ready.agent, providers: this.providersProvider() });
      const compactMode = resolveToolInstructionMode(compactProfile.llmTiers.default?.provider);
      const systemPromptTokens = estimateTokens(buildFullSystemPrompt(compactProfile, {}, compactMode));
      let summarizeStarted = false;
      const result = await this.compressionService.forceCompact({
        agent: ready.agent,
        sessionId: input.sessionId,
        // 会话级模型选择同源流入：压缩预算与摘要 default 候选与所选模型一致（readiness
        // 已按 selectedLlm 解析出 provider/modelName，此处仅当真有选择时携带）。
        ...(input.selectedLlm.trim() ? { selectedLlm: { provider: ready.provider, modelName: ready.modelName } } : {}),
        systemPromptTokens,
        signal: compactAbort.signal,
        onSummarizeStart: () => {
          summarizeStarted = true;
          void publishCompressionState({ type: "compression_started" }).catch(() => undefined);
        },
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
          if (summarizeStarted) {
            await publishCompressionState({ type: "compression_finished", reason: "summary_unavailable" });
          }
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
        // 带 type/content 才能让前端清"压缩中"并落摘要卡（reducer 契约：无 content 的 compression 帧视为 started）。
        payload: {
          category: "compression",
          detail: {
            type: "compression_summary",
            content: result.summaryMessage ? partsToPlainText(result.summaryMessage.content_parts) : "",
            forced: true,
            thread_key: "root",
            conversation_scope: "root",
            replaced_message_count: result.replacedMessageCount,
            replaces_up_to_seq: result.replacesUpToSeq,
          },
        },
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
      // 用户停止与真实失败分开收尾：停止不是错误（摘要只在 LLM 返回后才入库，中途 abort
      // 历史零改动），文案如实说明；帧 reason 同步区分，前端横线/胶囊按既有契约清除。
      const userStopped = compactAbort.signal.aborted;
      void publishCompressionState({ type: "compression_finished", reason: userStopped ? "user_stop" : "error" })
        .catch(() => undefined);
      return {
        command: "compact",
        success: false,
        content: userStopped
          ? "压缩已停止，历史保持原样"
          : `压缩失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      this.statusTracker.unregisterMaintenanceAbort(input.sessionId, compactAbort);
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
