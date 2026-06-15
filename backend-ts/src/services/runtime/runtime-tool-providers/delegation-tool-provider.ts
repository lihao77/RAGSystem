import type { AgentDelegationService } from "../../agent/agent-delegation-service.js";
import type { ToolExecutionResult } from "../../tools/memory-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
} from "../runtime-tool-types.js";
import {
  errorResult,
  readCallAgentArguments,
  readListChildAgentsArguments,
  readSendMessageArguments,
} from "../runtime-tool-bridge/arguments.js";
import {
  AGENT_DELEGATION_TOOLS,
  CALL_AGENT_TOOL_NAME,
  LIST_CHILD_AGENTS_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
} from "../runtime-tool-bridge/registry.js";

export class DelegationToolProvider implements RuntimeToolProvider {
  readonly id = "agent_delegation";

  constructor(private readonly getAgentDelegation: () => AgentDelegationService | null) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    if (!this.getAgentDelegation() || !input.agent?.delegation.enabled_agents?.length) {
      return [];
    }
    return AGENT_DELEGATION_TOOLS.map((tool) => ({ ...tool }));
  }

  canHandle(toolName: string): boolean {
    return (
      toolName === CALL_AGENT_TOOL_NAME ||
      toolName === LIST_CHILD_AGENTS_TOOL_NAME ||
      toolName === SEND_MESSAGE_TOOL_NAME
    );
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult> {
    const agentDelegation = this.getAgentDelegation();
    const toolName = call.toolName.trim();
    if (!agentDelegation) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }
    switch (toolName) {
      case CALL_AGENT_TOOL_NAME:
        return agentDelegation.callAgent(readCallAgentArguments(call.arguments, context.toolCallId ?? call.callId), context);
      case LIST_CHILD_AGENTS_TOOL_NAME:
        return agentDelegation.listChildAgents(readListChildAgentsArguments(call.arguments), context);
      case SEND_MESSAGE_TOOL_NAME:
        return agentDelegation.sendMessage(readSendMessageArguments(call.arguments, context.toolCallId ?? call.callId), context);
      default:
        return errorResult(`Delegation provider cannot handle tool: ${toolName}`, toolName || "unknown");
    }
  }
}
