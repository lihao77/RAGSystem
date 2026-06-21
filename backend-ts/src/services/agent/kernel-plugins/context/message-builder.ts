import type { AgentConfig } from "../../../../contracts/agent-config.js";
import type { ChatMessage } from "../../../integrations/llm-chat-client.js";
import { buildFullSystemPrompt, type AgentPromptContext } from "../../prompt-builder/index.js";
import { isRuntimeStableSystemContextContent } from "../../context-builder/index.js";
import {
  isSemanticTaggedContent,
  renderRuntimeXmlProtocolInstruction,
  renderSemanticBlock,
} from "../../../runtime/runtime-xml-protocol.js";
import type { RuntimeToolDefinition } from "../../../runtime/runtime-tool-types.js";
import type { ToolInstructionMode } from "../../kernel/contracts.js";

export function buildRuntimeMessages(
  agent: AgentConfig,
  conversation: ChatMessage[],
  options: { xmlProtocolTools?: RuntimeToolDefinition[]; promptContext?: AgentPromptContext; toolInstructionMode?: ToolInstructionMode; renderConversation: (messages: ChatMessage[]) => ChatMessage[] },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const systemParts: string[] = [];
  const systemPrompt = buildFullSystemPrompt(agent, options.promptContext, options.toolInstructionMode);
  if (systemPrompt) {
    systemParts.push(renderSemanticBlock("system_instruction", systemPrompt, { source: "agent_config" }));
  }
  let conversationIndex = 0;
  while (
    conversation[conversationIndex]?.role === "system" &&
    isRuntimeStableSystemContextContent(conversation[conversationIndex]?.content ?? "")
  ) {
    const content = conversation[conversationIndex]?.content.trim();
    if (content) {
      systemParts.push(renderSystemContextBlock(content));
    }
    conversationIndex += 1;
  }
  if (options.toolInstructionMode !== "native") {
    systemParts.push(renderRuntimeXmlProtocolInstruction(options.xmlProtocolTools ?? []));
  }
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }
  messages.push(...options.renderConversation(conversation.slice(conversationIndex)));
  return messages;
}

function renderSystemContextBlock(content: string): string {
  if (isSemanticTaggedContent(content)) {
    return content;
  }
  if (isRuntimeStableSystemContextContent(content)) {
    return renderSemanticBlock("context", content, { source: "memory" });
  }
  return renderSemanticBlock("runtime_instruction", content, { source: "runtime_context" });
}

export function renderSemanticChatMessage(message: ChatMessage): ChatMessage {
  if (isSemanticTaggedContent(message.content)) {
    return { ...message };
  }
  if (message.role === "user") {
    return {
      ...message,
      content: renderSemanticBlock("user_input", message.content, { source: "conversation" }),
    };
  }
  if (message.role === "assistant") {
    return {
      ...message,
      content: renderSemanticBlock("assistant_final", message.content, { source: "conversation" }),
    };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: renderSemanticBlock("tool_result", message.content, {
        source: "native_tool_message",
        call_id: message.tool_call_id ?? "",
        name: message.name ?? "",
      }),
    };
  }
  return { ...message, content: renderSystemContextBlock(message.content) };
}
