import {
  createCapability,
  provideCapability,
  type CapabilityProvider,
  type CapabilityRegistry,
  type CapabilityToken,
} from "./capability-registry.js";

/** 能力目录项：提供方暴露给蓝图勾选、下拉选项与 unknown 校验的最小单元。 */
export interface AgentCapabilityItem {
  readonly name: string;
  readonly display_name?: string;
  readonly description?: string;
  /** 提供方自定义附加信息（如 Skill 声明的 MCP 依赖），仅透传展示。 */
  readonly metadata?: Record<string, unknown>;
}

/**
 * 智能体能力提供方契约：插件把“可按 agent 勾选的能力目录 + per-agent 启用清单”
 * 以 `agent-capability/<id>` 前缀登记进能力注册表；agent-builder 只消费此抽象，
 * 不感知具体插件（skills / mcp / planning-sync / …），新增提供方无需改动 agent-builder。
 */
export interface AgentCapabilityProvider {
  /** 稳定 id，即蓝图 agents[].capabilities 的键；须匹配 AGENT_CAPABILITY_ID_PATTERN。 */
  readonly id: string;
  /** 配置页展示名（如「技能」、「MCP 服务器」）。 */
  readonly display_name: string;
  listItems(): Promise<readonly AgentCapabilityItem[]> | readonly AgentCapabilityItem[];
  /** 读取某 (team, agent) 当前启用的能力名清单。 */
  getAgentConfig(teamName: string, agentName: string): Promise<readonly string[]>;
  /** 写入某 (team, agent) 启用的能力名清单；发布物化与回滚都会调用，必须接受空清单。 */
  putAgentConfig(teamName: string, agentName: string, names: readonly string[]): Promise<void>;
}

export const AGENT_CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export const AGENT_CAPABILITY_TOKEN_PREFIX = "agent-capability/";

export function agentCapabilityToken(id: string): CapabilityToken<AgentCapabilityProvider> {
  if (!AGENT_CAPABILITY_ID_PATTERN.test(id)) {
    throw new Error(`Agent capability id '${id}' must match ${AGENT_CAPABILITY_ID_PATTERN.source}`);
  }
  return createCapability<AgentCapabilityProvider>(`${AGENT_CAPABILITY_TOKEN_PREFIX}${id}`);
}

export function provideAgentCapability(
  provider: AgentCapabilityProvider,
  owner?: string,
): CapabilityProvider<AgentCapabilityProvider> {
  return provideCapability(agentCapabilityToken(provider.id), provider, owner);
}

/** 枚举注册表中全部能力提供方（按 id 排序），跳过形状不符的登记项。 */
export function listAgentCapabilityProviders(
  registry: CapabilityRegistry,
): readonly AgentCapabilityProvider[] {
  return registry.list()
    .filter((id) => id.startsWith(AGENT_CAPABILITY_TOKEN_PREFIX))
    .map((id) => registry.get({ id }) as AgentCapabilityProvider | undefined)
    .filter((provider): provider is AgentCapabilityProvider => isAgentCapabilityProvider(provider))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function isAgentCapabilityProvider(value: unknown): value is AgentCapabilityProvider {
  if (!value || typeof value !== "object") return false;
  const provider = value as Record<string, unknown>;
  return typeof provider.id === "string"
    && AGENT_CAPABILITY_ID_PATTERN.test(provider.id)
    && typeof provider.display_name === "string"
    && typeof provider.listItems === "function"
    && typeof provider.getAgentConfig === "function"
    && typeof provider.putAgentConfig === "function";
}
