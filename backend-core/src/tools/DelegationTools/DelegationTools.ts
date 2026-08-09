import { isRecord } from "../../utils/guards.js";
import { z } from "zod";

import {
  buildTool,
  type RuntimeToolDefinition,
  type Tool,
  type ToolExecContext,
} from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../contracts/agent/agent-config.js";
import type { DelegationPort } from "../../services/agent/delegation/port.js";
import {
  readAgentArguments,
  readListChildAgentsArguments,
} from "../../services/runtime/runtime-tool-bridge/arguments.js";
import {
  AGENT_TOOL_NAME,
  LIST_CHILD_AGENTS_TOOL_NAME,
} from "../../services/runtime/runtime-tool-bridge/registry.js";
import { toolError } from "../../services/agent/sdk/tool-results.js";
import { metadataFrom, optionalBoolean, optionalInteger, optionalString } from "../schema-helpers.js";

/**
 * agent 配置查找端口：delegation 工厂用它解析可委派 agent 的展示信息（display_name/description/use_cases），
 * 从而让 agent 工具自描述其 allowlist。结构上与 agentConfig 容器的 getConfig 兼容。
 */
export interface DelegationAgentConfigLookup {
  getConfig(agentName: string, options?: { teamName?: string | null }): AgentConfig | null;
}

interface DelegatedAgentInfo {
  agent_name: string;
  display_name: string;
  description: string;
  use_cases: string;
}

interface DelegationToolDeps {
  agent: AgentConfig;
  /** 当前 session 的 team（用于解析 child agent 展示名）；SDK ToolExecContext 不携带 teamName，由工厂注入。 */
  teamName: string | null;
  getAgentDelegation: () => DelegationPort | null;
  /** 解析可委派 agent 展示信息；不提供则 allowlist 仅含 agent_name、无展示文案。 */
  agentConfig?: DelegationAgentConfigLookup | null;
  /** Child invocations receive a parent-only mailbox route even without child delegation allowlist. */
  canMessageParent?: boolean;
}

const agentSchema = z.object({
  agent_name: optionalString,
  agentName: z.string().optional(),
  child_agent_id: optionalString,
  childAgentId: z.string().optional(),
  message: z.string(),
  context_hint: optionalString,
  contextHint: optionalString,
  kind: z.enum(["progress", "request", "response", "result", "cancel"]).optional(),
  correlation_id: z.string().optional(),
  correlationId: z.string().optional(),
  reply_to_message_id: z.string().optional(),
  replyToMessageId: z.string().optional(),
  timeout_ms: optionalInteger,
  timeoutMs: optionalInteger,
  run_in_background: optionalBoolean,
  runInBackground: optionalBoolean,
}).strict();

const listChildAgentsSchema = z.object({
  agent_name: optionalString,
  agentName: optionalString,
  limit: optionalInteger,
}).strict();

const AGENT_DELEGATION_TOOLS: RuntimeToolDefinition[] = [
  {
    name: AGENT_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description:
      "Create a child Agent with agent_name, continue an existing child with child_agent_id, or send a message to the direct parent from a child context.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agent_name: {
          type: "string",
          description: "Target child Agent name from the current delegation allowlist. Omit when communicating with an existing child or the direct parent.",
        },
        child_agent_id: {
          type: "string",
          description: "Existing child Agent id returned by a previous agent call. Omit to create a new child or message the direct parent.",
        },
        message: {
          type: "string",
          description: "Task for a new child Agent, or message for an existing child/parent.",
        },
        context_hint: {
          type: "string",
          description: "Optional extra constraints, output format, or background.",
        },
        kind: {
          type: "string",
          enum: ["progress", "request", "response", "result", "cancel"],
          description: "Durable message semantic for an existing Agent. Defaults based on direction.",
        },
        correlation_id: {
          type: "string",
          description: "Correlation id for request/response messages.",
        },
        reply_to_message_id: {
          type: "string",
          description: "Message id this response replies to.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: 600000,
          description: "Optional delivery TTL for an existing Agent message.",
        },
        run_in_background: {
          type: "boolean",
          description: "Run the child Agent independently and immediately return background_task_id, child_agent_id, and run_id.",
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
];

export function createDelegationTools(deps: DelegationToolDeps): Tool[] {
  const { agent, teamName, getAgentDelegation } = deps;
  // 可见性筛选：未启用委派能力 或 当前 Agent 未配置 enabled_agents 时，整体不提供工具。
  const delegation = getAgentDelegation();
  const hasChildDelegation = delegation !== null && Boolean(agent.delegation.enabled_agents?.length);
  const canMessageParent = deps.canMessageParent === true;
  if (!hasChildDelegation && !canMessageParent) {
    return [];
  }
  // 可委派 agent 名单 + 展示信息直接进入 function schema，避免在 system prompt 重复整份工具手册。
  const delegatedAgents = resolveDelegatedAgents(agent, deps.agentConfig ?? null, teamName);
  const agentNames = delegatedAgents.map((item) => item.agent_name);
  const allowBackground = !!agent.tasks?.background;

  const definitionByName = new Map(AGENT_DELEGATION_TOOLS.map((definition) => [definition.name, definition]));
  const agentDef = withDelegationSelfDescription(
    omitBackgroundParam(definitionByName.get(AGENT_TOOL_NAME)!, allowBackground),
    agentNames,
    delegatedAgents,
  );
  const listChildAgentsDef = withAgentNameEnum(definitionByName.get(LIST_CHILD_AGENTS_TOOL_NAME)!, agentNames);

  const tools: Tool[] = [];
  if (hasChildDelegation || canMessageParent) tools.push(buildTool({
      ...metadataFrom(agentDef),
      inputSchema: agentSchema,
      isConcurrencySafe: () => false,
      concurrencyPolicy: agent.delegation.parallel_children ? "parallel" : "serial",
      concurrencyKey: (input) => `agent:${input.child_agent_id ?? input.agent_name ?? "parent"}:${input.message}`,
      call: (input, ctx: ToolExecContext) => {
        const service = getAgentDelegation();
        return service
          ? service.agent(
              { agent, teamName, input: readAgentArguments(input, ctx.toolCallId ?? undefined) },
              ctx,
            )
          : toolError(AGENT_TOOL_NAME, "当前 Agent 未启用子 Agent 委派能力");
      },
    }));
  if (hasChildDelegation) tools.push(buildTool({
      ...metadataFrom(listChildAgentsDef),
      inputSchema: listChildAgentsSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input, ctx: ToolExecContext) => {
        const service = getAgentDelegation();
        return service
          ? service.listChildAgents({ agent, teamName, input: readListChildAgentsArguments(input) }, ctx)
          : toolError(LIST_CHILD_AGENTS_TOOL_NAME, "当前 Agent 未启用子 Agent 委派能力");
      },
    }));
  return tools;
}

/** 解析可委派 agent 展示信息（原 buildPromptDelegatedAgents 逻辑，下沉到工具工厂自描述）。 */
function resolveDelegatedAgents(
  agent: AgentConfig,
  lookup: DelegationAgentConfigLookup | null,
  teamName: string | null,
): DelegatedAgentInfo[] {
  const enabledAgents = agent.delegation.enabled_agents ?? [];
  return enabledAgents
    .filter((agentName) => agentName && agentName !== agent.agent_name)
    .map((agentName) => {
      const config = lookup?.getConfig(agentName, { teamName }) ?? null;
      const behavior = isRecord(config?.custom_params.behavior) ? config!.custom_params.behavior : {};
      const rawUseCases = behavior.use_cases;
      const useCases = Array.isArray(rawUseCases) ? rawUseCases.map(String).join(", ") : normalizeUseCases(rawUseCases);
      return {
        agent_name: config?.agent_name ?? agentName,
        display_name: config?.display_name ?? agentName,
        description: config?.description ?? "",
        use_cases: useCases,
      };
    });
}

function normalizeUseCases(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}



/** 给带 agent_name 参数的工具补 enum（限定为当前可委派 agent 名）。 */
function withAgentNameEnum(definition: RuntimeToolDefinition, agentNames: string[]): RuntimeToolDefinition {
  if (!agentNames.length) {
    return definition;
  }
  const parameters: Record<string, unknown> = isRecord(definition.parameters) ? { ...definition.parameters } : { type: "object" };
  const properties: Record<string, unknown> = isRecord(parameters.properties) ? { ...parameters.properties } : {};
  const rawAgentName: Record<string, unknown> = isRecord(properties.agent_name) ? properties.agent_name : { type: "string" };
  properties.agent_name = {
    ...rawAgentName,
    enum: agentNames,
  };
  parameters.properties = properties;
  return { ...definition, parameters };
}

function omitBackgroundParam(definition: RuntimeToolDefinition, allowBackground: boolean): RuntimeToolDefinition {
  if (allowBackground) return definition;
  const parameters = definition.parameters;
  const properties = isRecord(parameters.properties) ? { ...parameters.properties } : {};
  if (!("run_in_background" in properties) && !("runInBackground" in properties)) return definition;
  delete properties.run_in_background;
  delete properties.runInBackground;
  return { ...definition, parameters: { ...parameters, properties } };
}

/** agent 自描述：候选名单及职责进入 agent_name schema，system prompt 只保留最小委派策略。 */
function withDelegationSelfDescription(
  definition: RuntimeToolDefinition,
  agentNames: string[],
  delegatedAgents: DelegatedAgentInfo[],
): RuntimeToolDefinition {
  const withEnum = withAgentNameEnum(definition, agentNames);
  const parameters: Record<string, unknown> = isRecord(withEnum.parameters) ? { ...withEnum.parameters } : { type: "object" };
  const properties: Record<string, unknown> = isRecord(parameters.properties) ? { ...parameters.properties } : {};
  const agentNameProperty = isRecord(properties.agent_name) ? { ...properties.agent_name } : { type: "string" };
  const candidates = delegatedAgents.map(formatDelegatedAgent).join("; ");
  properties.agent_name = {
    ...agentNameProperty,
    description: candidates
      ? `Target child Agent. Allowed candidates: ${candidates}`
      : "Target child Agent name from the current delegation allowlist.",
  };
  parameters.properties = properties;
  return {
    ...withEnum,
    parameters,
    extended_usage: "仅在直接回答或直接工具不足时委派；优先复用已有 child_agent_id，单个子 Agent 足够时不要拆成多个。",
  };
}

function formatDelegatedAgent(item: DelegatedAgentInfo): string {
  const label = item.display_name && item.display_name !== item.agent_name
    ? `${item.agent_name} (${item.display_name})`
    : item.agent_name;
  const details = [item.description, item.use_cases ? `use cases: ${item.use_cases}` : ""].filter(Boolean).join(", ");
  return details ? `${label}: ${details}` : label;
}
