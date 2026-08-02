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
import { metadataFrom, optionalBoolean, optionalInteger, optionalString } from "../schema-helpers.js";

/**
 * agent 配置查找端口：delegation 工厂用它解析可委派 agent 的展示信息（display_name/description/use_cases），
 * 从而让 call_agent 等工具自描述其 allowlist。结构上与 agentConfig 容器的 getConfig 兼容。
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
}

const callAgentSchema = z.object({
  agent_name: z.string(),
  agentName: z.string().optional(),
  task: z.string(),
  context_hint: optionalString,
  contextHint: optionalString,
  run_in_background: optionalBoolean,
  runInBackground: optionalBoolean,
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
  run_in_background: optionalBoolean,
  runInBackground: optionalBoolean,
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
        run_in_background: {
          type: "boolean",
          description: "Run this follow-up independently and immediately return background_task_id and run_id.",
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
  // 可委派 agent 名单 + 展示信息——作为 call_agent 等工具的自描述（agent_name enum + extended_usage 清单）。
  const delegatedAgents = resolveDelegatedAgents(agent, deps.agentConfig ?? null, teamName);
  const agentNames = delegatedAgents.map((item) => item.agent_name);
  const exampleAgent = delegatedAgents[0]?.agent_name ?? agentNames[0] ?? "agent_name";
  const allowBackground = !!agent.tasks?.background;

  const definitionByName = new Map(AGENT_DELEGATION_TOOLS.map((definition) => [definition.name, definition]));
  const callAgentDef = withDelegationSelfDescription(
    omitBackgroundParam(definitionByName.get(CALL_AGENT_TOOL_NAME)!, allowBackground),
    agentNames,
    delegatedAgents,
    exampleAgent,
    /* includeExample */ true,
  );
  const listChildAgentsDef = withAgentNameEnum(definitionByName.get(LIST_CHILD_AGENTS_TOOL_NAME)!, agentNames);
  const sendMessageDef = withSendMessageSelfDescription(
    omitBackgroundParam(definitionByName.get(SEND_MESSAGE_TOOL_NAME)!, allowBackground),
    exampleAgent,
  );

  return [
    buildTool({
      ...metadataFrom(callAgentDef),
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
    }),
    buildTool({
      ...metadataFrom(sendMessageDef),
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

/** call_agent 自描述：agent_name enum + extended_usage（委派语义 + 可委派清单）+ 创建示例。 */
function withDelegationSelfDescription(
  definition: RuntimeToolDefinition,
  agentNames: string[],
  delegatedAgents: DelegatedAgentInfo[],
  exampleAgent: string,
  includeExample: boolean,
): RuntimeToolDefinition {
  const withEnum = withAgentNameEnum(definition, agentNames);
  const lines = [
    "委派子 Agent 仅在直接回答或直接工具不足以完成任务时使用。优先顺序：直答 > direct tool > 单子 Agent > 多 Agent。",
    "",
    "- agent_name 必须从下方\"可委派子 Agent\"清单中选择",
    "- 首次创建子 Agent 用 call_agent；已有 child_agent_id 时优先用 send_message 续接",
    "- task 需写完整上下文、目标与输出要求；只有确实需要目标 Agent 专长或独立上下文时才委派",
    "- 若一个子 Agent 足以完成任务，就不要拆成多个；子 Agent 已返回足够结果时直接收束",
    "- 子 Agent 失败后，下一次委派必须改变任务描述/范围/输入/目标，不要原样重发",
    "- 长耗时且可独立完成的任务可设 run_in_background=true；结果中的 task_id（兼容别名 background_task_id）可交给 task_output/task_stop 查询或停止",
    "",
    "可委派子 Agent：",
  ];
  for (const item of delegatedAgents) {
    lines.push(`- \`${item.agent_name}\` (${item.display_name || item.agent_name}): ${item.description}`);
    if (item.use_cases) {
      lines.push(`  - use_cases: ${item.use_cases}`);
    }
  }
  const result: RuntimeToolDefinition = {
    ...withEnum,
    extended_usage: lines.join("\n"),
  };
  if (includeExample) {
    result.examples = [
      {
        input: {
          agent_name: exampleAgent,
          task: "查询2023年广西洪涝灾害受灾人口，需要分市统计",
          context_hint: "返回 Markdown 表格，并保留统计口径说明",
          run_in_background: true,
        },
      },
    ];
  }
  return result;
}

/** send_message 自描述：续接语义 + 示例。 */
function withSendMessageSelfDescription(definition: RuntimeToolDefinition, exampleAgent: string): RuntimeToolDefinition {
  return {
    ...definition,
    extended_usage:
      "续接已有子 Agent：向既有 child_agent_id 发后续消息。child_agent_id 由 call_agent 返回（取 content.items.0.child_agent_id），或用 list_child_agents 找回。",
    examples: [
      {
        input: {
          child_agent_id: "{result_1.content.items.0.child_agent_id}",
          message: "继续基于上一轮结果补充结论，并输出最终摘要",
        },
      },
    ],
  };
}
