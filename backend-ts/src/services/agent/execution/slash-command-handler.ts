import type { AgentRunStartResult } from "../../../contracts/execution/execution.js";
import type { AgentSessionApplication } from "../../sessions/index.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import type { DurableClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import { buildFullSystemPrompt, estimateTokens, resolveToolInstructionMode } from "@ragsystem/agent-sdk";
import { projectAgentProfile } from "../sdk/projection.js";
import type { AgentCompressionService } from "../context-compression/compression-service.js";
import { asString, normalizeSessionEntryAgent } from "./helpers.js";
import { resolveReadyAgent } from "./readiness.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { TenantId } from "../../../identity/types.js";

interface ParsedSlashCommand {
  name: string;
  args: string;
  mode: "system" | "prompt";
  expandedTask: string;
}

interface SystemSlashCommandResult {
  command: string;
  success: boolean;
  content: string;
  error?: string;
  data?: unknown;
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
    private readonly sessions: AgentSessionApplication,
    private readonly statusTracker: AgentExecutionStatusTracker,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly providersProvider: () => ModelProviderConfig[],
    private readonly conversationStore: ConversationStore,
    private readonly compressionService: AgentCompressionService | null,
    private readonly clientEvents: DurableClientEventPublisher,
  ) {}

  handle(input: {
    sessionId: string;
    userId: string;
    requestId: string;
    selectedLlm: string;
    command: ParsedSlashCommand;
    originalTask: string;
  }): Promise<AgentRunStartResult | null> {
    if (input.command.mode === "prompt") {
      return Promise.resolve(null);
    }
    return this.executeSystemSlashCommand(input);
  }

  private async executeSystemSlashCommand(input: {
    sessionId: string;
    userId: string;
    requestId: string;
    selectedLlm: string;
    command: ParsedSlashCommand;
    originalTask: string;
  }): Promise<AgentRunStartResult> {
    if (!this.sessions.getSession(input.sessionId)) {
      this.sessions.createSession({ tenantId: this.tenantId, sessionId: input.sessionId, userId: input.userId });
    }
    this.sessions.addMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.originalTask,
      metadata: {
        msg_type: MSG_TYPE.COMMAND,
        command: input.command.name,
        command_mode: input.command.mode,
      },
    });
    const result = await this.resolveSystemSlashCommandResult(input);
    const message = this.sessions.addMessage({
      sessionId: input.sessionId,
      role: "system",
      content: result.content,
      metadata: {
        msg_type: MSG_TYPE.COMMAND_RESULT,
        command: result.command,
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
      },
    });
    this.clientEvents.publish(input.sessionId, {
      type: "state_sync",
      session_id: input.sessionId,
      payload: {
        category: "command_result",
        ref: { message_id: message.id },
        detail: {
          command: result.command,
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
      started: result.success,
      session_id: input.sessionId,
      kind: "command",
    };
  }

  private async resolveSystemSlashCommandResult(input: {
    sessionId: string;
    requestId: string;
    selectedLlm: string;
    command: ParsedSlashCommand;
  }): Promise<SystemSlashCommandResult> {
    if (input.command.name !== "compact") {
      return executeStaticSystemSlashCommand(input.command);
    }
    const runningStatus = this.statusTracker.getStatusBySession(input.sessionId);
    if (runningStatus?.status === "running" || runningStatus?.status === "pending") {
      return {
        command: "compact",
        success: false,
        content: "该会话正在执行任务，请等待完成后再压缩",
      };
    }
    const sessionMetadata = this.sessions.getSession(input.sessionId)?.metadata ?? {};
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
    try {
      if (!this.compressionService) {
        return { command: "compact", success: false, content: "压缩服务未装配", error: "compression_unavailable" };
      }
      // systemPromptTokens 粗估(buildFullSystemPrompt base,无 tools/memory);forceCompact 不判阈值,仅影响返回 budgetTokens 展示。
      const compactProfile = projectAgentProfile({ agent: ready.agent, providers: this.providersProvider() });
      const compactMode = resolveToolInstructionMode(compactProfile.llmTiers.default?.provider);
      const systemPromptTokens = estimateTokens(buildFullSystemPrompt(compactProfile, {}, compactMode));
      const result = await this.compressionService.forceCompact({
        agent: ready.agent,
        sessionId: input.sessionId,
        systemPromptTokens,
      });
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
      this.clientEvents.publish(input.sessionId, {
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
    }
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
    return { name, args, mode: "system", expandedTask: "" };
  }
  const promptCommand = PROMPT_SLASH_COMMANDS[name];
  if (!promptCommand) {
    return { name, args, mode: "system", expandedTask: "" };
  }
  if (!args) {
    return { name, args, mode: "system", expandedTask: "" };
  }
  return {
    name,
    args,
    mode: "prompt",
    expandedTask: promptCommand.template.replace("{args}", args),
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
