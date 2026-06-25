/**
 * preview 端口（调试用）—— 组"模型真实收到的 LLM 请求"，不调 LLM、不进 ReAct 循环。
 *
 * 与内核 makeContextPort + protocol.prepareMessages 同源：复用 buildFullSystemPrompt（system prompt 构建）
 * + renderRuntimeXmlProtocolInstruction/renderNativeXmlProtocolInstruction（协议说明注入）
 * + renderXmlModelMessage/renderNativeModelMessage（历史渲染）。调试快照调本函数，保证"所见即模型所收"。
 *
 * 不依赖 protocol 实例（prepareMessages 是其私有方法），但用同一组导出的纯函数复现拼接逻辑，
 * 避免双份渲染漂移。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";

import type { ToolInstructionMode } from "./contracts.js";
import { buildFullSystemPrompt } from "./prompt/prompt-builder.js";
import type { AgentPromptContext } from "./prompt/types.js";
import type { RuntimeToolDefinition } from "./prompt/tool-types.js";
import {
  renderNativeXmlProtocolInstruction,
  renderNativeModelMessage,
  renderRuntimeXmlProtocolInstruction,
  renderSemanticBlock,
  renderXmlModelMessage,
} from "./protocol/index.js";
import type { AgentProfile } from "./types.js";
import { estimateTokens } from "./compression/token-estimate.js";

export interface PreviewLlmRequestInput {
  /** prompt 构建只读 behavior.systemPrompt；放宽为 Pick<AgentProfile, "behavior">，调试无需完整 tier 投影。 */
  profile: Pick<AgentProfile, "behavior">;
  /** prompt 上下文；tools 必须由消费端传（preview 不持有 registry）。 */
  promptContext: AgentPromptContext;
  /** 结构化历史（未经协议渲染的原始 ChatMessage[]）。 */
  conversation: ChatMessage[];
  mode: ToolInstructionMode;
}

export interface PreviewLlmRequestResult {
  /** 完整 system prompt（buildFullSystemPrompt 产出，含 tools/skills/delegation/background 段）。 */
  systemPrompt: string;
  /** 协议说明块（注入到 system message；XML 含 tool_manifest，native 仅阶段标签说明）。 */
  protocolInstruction: string;
  /** 模型真实收到的消息序列（system 已注入协议说明 + 历史经协议渲染）。 */
  requestMessages: ChatMessage[];
  toolDefinitions: RuntimeToolDefinition[];
  tokenStats: {
    systemPromptTokens: number;
    historyTokens: number;
    totalTokens: number;
  };
}

/**
 * 组预览请求。system message 的拼接按 mode 与 protocol.prepareMessages 同源：
 * - xml：`<system_instruction source="agent_config">systemPrompt</system_instruction>` + 协议说明
 * - native：`systemPrompt` + 协议说明（不包语义块）
 */
export function previewLlmRequest(input: PreviewLlmRequestInput): PreviewLlmRequestResult {
  const { profile, promptContext, conversation, mode } = input;
  const tools = promptContext.tools ?? [];

  const systemPrompt = buildFullSystemPrompt(profile, promptContext, mode);
  const protocolInstruction = mode === "native"
    ? renderNativeXmlProtocolInstruction()
    : renderRuntimeXmlProtocolInstruction(tools);

  const systemContent = mode === "native"
    ? [systemPrompt, protocolInstruction].join("\n\n")
    : [renderSemanticBlock("system_instruction", systemPrompt, { source: "agent_config" }), protocolInstruction].join("\n\n");

  const render = mode === "native" ? renderNativeModelMessage : renderXmlModelMessage;
  const requestMessages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...conversation.map(render),
  ];

  let systemPromptTokens = 0;
  let historyTokens = 0;
  for (const message of requestMessages) {
    const tokens = estimateTokens(message.content ?? "");
    if (message.role === "system") {
      systemPromptTokens += tokens;
    } else {
      historyTokens += tokens;
    }
  }

  return {
    systemPrompt,
    protocolInstruction,
    requestMessages,
    toolDefinitions: tools,
    tokenStats: {
      systemPromptTokens,
      historyTokens,
      totalTokens: systemPromptTokens + historyTokens,
    },
  };
}
