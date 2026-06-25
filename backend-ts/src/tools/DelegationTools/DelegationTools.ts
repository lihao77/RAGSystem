import { z } from "zod";

import {
  buildTool,
  type RuntimeToolDefinition,
  type Tool,
  type ToolExecContext,
} from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../contracts/agent-config.js";
import type { DelegationPort } from "../../services/agent/delegation/port.js";
import {
  readCallAgentArguments,
  readListChildAgentsArguments,
  readSendMessageArguments,
} from "../../services/runtime/runtime-tool-bridge/arguments.js";
import {
  CALL_AGENT_TOOL_NAME,
  LIST_CHILD_AGENTS_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
} from "../../services/runtime/runtime-tool-bridge/registry.js";
import { toolError } from "../../services/agent/sdk/tool-results.js";
import { metadataFrom, optionalInteger, optionalString } from "../schema-helpers.js";

interface DelegationToolDeps {
  agent: AgentConfig;
  /** 当前 session 的 team（用于解析 child agent 展示名）；SDK ToolExecContext 不携带 teamName，由工厂注入。 */
  teamName: string | null;
  getAgentDelegation: () => DelegationPort | null;
}

const callAgentSchema = z.object({
  agent_name: z.string(),
  agentName: z.string().optional(),
  task: z.string(),
  context_hint: optionalString,
  contextHint: optionalString,
}).strict();

const listChildAgentsSchema = z.object({
  agent_name: optionalString,
  agentName: optionalString,
  limit: optionalInteger,
}).strict();

const sendMessageSchema = z.object({
  child_agent_id: z.string(),
  childAgentId: z.string().optional(),
  message: z.string(),
}).strict();

const AGENT_DELEGATION_TOOLS: RuntimeToolDefinition[] = [
  {
    name: CALL_AGENT_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description:
      "Delegate a self-contained subtask to one allowed child Agent. agent_name must come from the current Agent delegation allowlist.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["agent_name", "task"],
      properties: {
        agent_name: {
          type: "string",
          description: "Target child Agent name from the current delegation allowlist.",
        },
        task: {
          type: "string",
          description: "Complete task description with all context the child Agent needs.",
        },
        context_hint: {
          type: "string",
          description: "Optional extra constraints, output format, or background.",
        },
      },
    },
  },
  {
    name: LIST_CHILD_AGENTS_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "List existing child Agent sessions in the current session so a prior child_agent_id can be reused.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agent_name: {
          type: "string",
          description: "Optional Agent name filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of child Agents to return. Defaults to 20.",
        },
      },
    },
  },
  {
    name: SEND_MESSAGE_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Send a follow-up message to an existing child Agent session by child_agent_id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["child_agent_id", "message"],
      properties: {
        child_agent_id: {
          type: "string",
          description: "Child Agent id returned by call_agent or list_child_agents.",
        },
        message: {
          type: "string",
          description: "Follow-up task or correction for the existing child Agent.",
        },
      },
    },
  },
];

export function createDelegationTools(deps: DelegationToolDeps): Tool[] {
  const { agent, teamName, getAgentDelegation } = deps;
  // 可见性筛选：未启用委派能力 或 当前 Agent 未配置 enabled_agents 时，整体不提供工具。
  if (getAgentDelegation() === null || !(agent.delegation.enabled_agents?.length)) {
    return [];
  }
  const definitionByName = new Map(AGENT_DELEGATION_TOOLS.map((definition) => [definition.name, definition]));
  return [
    buildTool({
      ...metadataFrom(definitionByName.get(CALL_AGENT_TOOL_NAME)!),
      inputSchema: callAgentSchema,
      isConcurrencySafe: () => false,
      call: (input, ctx: ToolExecContext) => {
        const service = getAgentDelegation();
        return service
          ? service.callAgent(
              { agent, teamName, input: readCallAgentArguments(input, ctx.toolCallId ?? undefined) },
              ctx,
            )
          : toolError(CALL_AGENT_TOOL_NAME, "当前 Agent 未启用子 Agent 委派能力");
      },
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(LIST_CHILD_AGENTS_TOOL_NAME)!),
      inputSchema: listChildAgentsSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input, ctx: ToolExecContext) => {
        const service = getAgentDelegation();
        return service
          ? service.listChildAgents({ agent, teamName, input: readListChildAgentsArguments(input) }, ctx)
          : toolError(LIST_CHILD_AGENTS_TOOL_NAME, "当前 Agent 未启用子 Agent 委派能力");
      },
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(SEND_MESSAGE_TOOL_NAME)!),
      inputSchema: sendMessageSchema,
      isConcurrencySafe: () => false,
      call: (input, ctx: ToolExecContext) => {
        const service = getAgentDelegation();
        return service
          ? service.sendMessage(
              { agent, teamName, input: readSendMessageArguments(input, ctx.toolCallId ?? undefined) },
              ctx,
            )
          : toolError(SEND_MESSAGE_TOOL_NAME, "当前 Agent 未启用子 Agent 委派能力");
      },
    }),
  ];
}
