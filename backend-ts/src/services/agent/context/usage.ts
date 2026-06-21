import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import { isStableSystemContextContent } from "../context-builder/index.js";
import { estimateTokens } from "../context-compression/index.js";
import { buildFullSystemPrompt, type AgentPromptContext } from "../prompt-builder/index.js";
import { resolveToolInstructionMode } from "../kernel-plugins/protocol/select-protocol.js";

/**
 * context.usage 事件 payload 计算 —— 从 execution/helpers.ts 迁入，归位到上下文模块。
 * system_prompt（含稳定 system context）与 history 分桶估算，附压缩结果摘要。
 */
export function buildContextUsagePayload(input: {
  agent: AgentConfig;
  provider?: ModelProviderConfig | null;
  promptContext: AgentPromptContext;
  budgetTokens: number;
  messages: ChatMessage[];
  round: number;
  runId: string;
  taskId: string;
  requestId: string;
  compressionResult?: {
    status: string;
    reason: string;
    replacedMessageCount: number;
    replacesUpToSeq: number | null;
  } | null;
}): Record<string, unknown> {
  const rawSystemPromptTokens = estimateTokens(
    buildFullSystemPrompt(input.agent, input.promptContext, input.provider ? resolveToolInstructionMode(input.provider) : "xml"),
  );
  const systemContextTokens = input.messages
    .filter((message) => message.role === "system" && isStableSystemContextContent(message.content))
    .reduce((total, message) => total + estimateTokens(message.content), 0);
  const historyTokens = input.messages
    .filter((message) => message.role !== "system" || !isStableSystemContextContent(message.content))
    .reduce((total, message) => total + estimateTokens(message.content), 0);
  const systemPromptTokens = rawSystemPromptTokens + systemContextTokens;
  const totalTokens = systemPromptTokens + historyTokens;
  return {
    used_tokens: totalTokens,
    system_prompt_tokens: systemPromptTokens,
    total_tokens: totalTokens,
    budget_tokens: input.budgetTokens,
    round: input.round,
    compressing: false,
    agent_name: input.agent.agent_name,
    run_id: input.runId,
    task_id: input.taskId,
    request_id: input.requestId,
    ...(input.compressionResult
      ? {
          compression: {
            status: input.compressionResult.status,
            reason: input.compressionResult.reason,
            replaced_message_count: input.compressionResult.replacedMessageCount,
            replaces_up_to_seq: input.compressionResult.replacesUpToSeq,
          },
        }
      : {}),
  };
}
