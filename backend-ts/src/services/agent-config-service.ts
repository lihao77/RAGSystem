import type { AgentConfig, AgentInfo, CreateAgentRequest, TeamInfo, TeamSummary } from "../contracts/agent-config.js";

type TeamConfigs = Map<string, AgentConfig>;

const defaultLlmTier = {
  provider: "my",
  provider_type: "deepseek",
  model_name: "deepseek-chat",
  temperature: 0.3,
  max_completion_tokens: 4096,
  max_context_tokens: 128000,
  extra_params: {},
};

export class AgentConfigService {
  private activeTeam = "default";
  private readonly teams = new Map<string, TeamConfigs>();

  constructor() {
    this.teams.set("default", new Map(Object.entries(buildDefaultAgentConfigs())));
  }

  listConfigs(): Record<string, AgentConfig> {
    return configsToRecord(this.getActiveConfigs());
  }

  listAgents(): AgentInfo[] {
    return Array.from(this.getActiveConfigs().values())
      .map((config) => configToAgentInfo(config))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getConfig(agentName: string): AgentConfig | null {
    const config = this.getActiveConfigs().get(agentName);
    return config ? cloneConfig(config) : null;
  }

  createAgent(payload: CreateAgentRequest): AgentConfig {
    const agentName = normalizeAgentName(payload.agent_name);
    if (this.getActiveConfigs().has(agentName)) {
      throw new Error(`智能体 ${agentName} 已存在`);
    }

    const config = buildCustomAgentConfig({
      ...payload,
      agent_name: agentName,
    });
    this.enforceSingleDefaultEntry(agentName, config.default_entry);
    this.getActiveConfigs().set(agentName, config);
    return cloneConfig(config);
  }

  replaceConfig(agentName: string, payload: AgentConfig): AgentConfig {
    const config = normalizeConfig({
      ...payload,
      agent_name: agentName,
    });
    this.enforceSingleDefaultEntry(agentName, config.default_entry);
    this.getActiveConfigs().set(agentName, config);
    return cloneConfig(config);
  }

  patchConfig(agentName: string, patch: Record<string, unknown>): AgentConfig | null {
    const current = this.getActiveConfigs().get(agentName);
    if (!current) {
      return null;
    }
    const merged = normalizeConfig(deepMerge(cloneConfig(current), patch) as AgentConfig);
    merged.agent_name = agentName;
    this.enforceSingleDefaultEntry(agentName, merged.default_entry);
    this.getActiveConfigs().set(agentName, merged);
    return cloneConfig(merged);
  }

  deleteConfig(agentName: string): boolean {
    return this.getActiveConfigs().delete(agentName);
  }

  deleteAgent(agentName: string): boolean {
    const normalized = normalizeAgentName(agentName);
    const config = this.getActiveConfigs().get(normalized);
    if (!config) {
      return false;
    }
    if (config.default_entry || normalized === "orchestrator_agent") {
      throw new Error("系统核心智能体禁止删除");
    }
    return this.getActiveConfigs().delete(normalized);
  }

  listTeams(): TeamSummary {
    const teams = Array.from(this.teams.keys())
      .sort()
      .map((teamName) => this.toTeamInfo(teamName));
    return {
      active_team: this.activeTeam,
      teams,
    };
  }

  createTeam(teamName: string, sourceTeam?: string | null): TeamSummary {
    const normalized = normalizeTeamName(teamName);
    if (this.teams.has(normalized)) {
      throw new Error(`team '${normalized}' 已存在`);
    }
    const source = sourceTeam?.trim() ? this.getTeamConfigs(sourceTeam.trim()) : new Map<string, AgentConfig>();
    this.teams.set(normalized, cloneConfigMap(source));
    return this.listTeams();
  }

  activateTeam(teamName: string): TeamSummary {
    const normalized = normalizeTeamName(teamName);
    this.getTeamConfigs(normalized);
    this.activeTeam = normalized;
    return this.listTeams();
  }

  deleteTeam(teamName: string): TeamSummary {
    const normalized = normalizeTeamName(teamName);
    if (!this.teams.has(normalized)) {
      throw new Error(`team '${normalized}' 不存在`);
    }
    if (this.teams.size <= 1) {
      throw new Error("至少需要保留一个 team");
    }
    this.teams.delete(normalized);
    if (this.activeTeam === normalized) {
      this.activeTeam = Array.from(this.teams.keys()).sort()[0] ?? "default";
    }
    return this.listTeams();
  }

  renameTeam(teamName: string, newTeamName: string): TeamSummary {
    const current = normalizeTeamName(teamName);
    const next = normalizeTeamName(newTeamName);
    if (!this.teams.has(current)) {
      throw new Error(`team '${current}' 不存在`);
    }
    if (current !== next && this.teams.has(next)) {
      throw new Error(`team '${next}' 已存在`);
    }
    const configs = this.getTeamConfigs(current);
    this.teams.delete(current);
    this.teams.set(next, configs);
    if (this.activeTeam === current) {
      this.activeTeam = next;
    }
    return this.listTeams();
  }

  copyAgentsToTeam(targetTeam: string, sourceTeam: string, agentNames: string[]): TeamSummary {
    if (agentNames.length === 0) {
      throw new Error("agent_names 不能为空");
    }
    const source = this.getTeamConfigs(sourceTeam);
    const target = this.getTeamConfigs(targetTeam);
    for (const agentName of agentNames) {
      const config = source.get(agentName);
      if (!config) {
        throw new Error(`源 team 中不存在智能体 '${agentName}'`);
      }
      target.set(agentName, cloneConfig(config));
    }
    return this.listTeams();
  }

  resetDefaultTeam(): TeamSummary {
    this.teams.set("default", new Map(Object.entries(buildDefaultAgentConfigs())));
    if (!this.teams.has(this.activeTeam)) {
      this.activeTeam = "default";
    }
    return this.listTeams();
  }

  listAvailableTools(): Array<{ name: string; description: string; category: string }> {
    return [
      { name: "read_file", description: "Read a file from the managed workspace", category: "filesystem" },
      { name: "write_file", description: "Write a file in the managed workspace", category: "filesystem" },
      { name: "edit_file", description: "Edit an existing file in the managed workspace", category: "filesystem" },
      { name: "preview_data_structure", description: "Preview structured data files", category: "data" },
      { name: "execute_bash", description: "Execute a shell command with approval boundaries", category: "execution" },
    ];
  }

  getMemoryConfigMetadata(): { scopes: Array<Record<string, string>> } {
    return {
      scopes: [
        {
          name: "team",
          description: "团队级长期记忆，适合跨会话复用的共享偏好、约束与背景事实。",
          read_label: "允许读取",
          write_label: "允许写入",
          archive_label: "允许归档",
        },
        {
          name: "session",
          description: "当前会话记忆，适合记录本轮协作中形成的稳定偏好和上下文。",
          read_label: "允许读取",
          write_label: "允许写入",
          archive_label: "允许归档",
        },
        {
          name: "agent",
          description: "当前 team 内 Agent 私有记忆。",
          read_label: "允许读取",
          write_label: "允许写入",
          archive_label: "允许归档",
        },
        {
          name: "workspace",
          description: "当前工作区记忆，适合绑定具体 workspace 的本地约定和上下文。",
          read_label: "允许读取",
          write_label: "允许写入",
          archive_label: "允许归档",
        },
      ],
    };
  }

  listAvailableMcpServers(): unknown[] {
    return [];
  }

  listAvailableSkills(): unknown[] {
    return [];
  }

  private getActiveConfigs(): TeamConfigs {
    return this.getTeamConfigs(this.activeTeam);
  }

  private getTeamConfigs(teamName: string): TeamConfigs {
    const normalized = normalizeTeamName(teamName);
    const configs = this.teams.get(normalized);
    if (!configs) {
      throw new Error(`team '${normalized}' 不存在`);
    }
    return configs;
  }

  private toTeamInfo(teamName: string): TeamInfo {
    const configs = this.getTeamConfigs(teamName);
    const agents = Array.from(configs.keys()).sort();
    return {
      team_name: teamName,
      file_path: `teams/${teamName}.yaml`,
      is_active: teamName === this.activeTeam,
      agent_count: agents.length,
      agents,
    };
  }

  private enforceSingleDefaultEntry(agentName: string, isDefaultEntry: boolean): void {
    if (!isDefaultEntry) {
      return;
    }
    for (const [name, config] of this.getActiveConfigs()) {
      if (name !== agentName && config.default_entry) {
        this.getActiveConfigs().set(name, {
          ...config,
          default_entry: false,
        });
      }
    }
  }
}

function buildDefaultAgentConfigs(): Record<string, AgentConfig> {
  const specialistAgents = ["team_maker", "plan_agent", "explor_agent", "general_agent", "review_agent", "test_agent"];
  return {
    orchestrator_agent: buildSystemAgentConfig({
      agent_name: "orchestrator_agent",
      display_name: "Orchestrator Agent",
      description: "系统默认主编排器，负责理解用户需求、路由任务并整合最终答案。",
      system_prompt: "你是系统默认主编排器，负责优先直接解决问题；必要时再委派给 team 内其他系统 Agent。",
      default_entry: true,
      tools: ["read_file", "write_file", "edit_file", "preview_data_structure", "execute_bash"],
      delegation: specialistAgents,
      tasks: { workflow: true, background: true },
    }),
    team_maker: buildSystemAgentConfig({
      agent_name: "team_maker",
      display_name: "Team Maker",
      description: "系统默认组队 Agent，负责生成、整理和调整 team 配置方案。",
      system_prompt: "你负责根据目标生成、整理和调整 team 配置，输出尽量少而完整的 team 方案。",
      skills: ["team-generation"],
      delegation: ["plan_agent", "explor_agent", "general_agent"],
    }),
    plan_agent: buildSystemAgentConfig({
      agent_name: "plan_agent",
      display_name: "Plan Agent",
      description: "系统默认规划 Agent，负责方案设计、任务拆解和实现路径规划。",
      system_prompt: "你负责阅读上下文后给出精炼、可执行的实现计划，明确改动点、验证路径和边界。",
      delegation: ["explor_agent", "general_agent"],
    }),
    explor_agent: buildSystemAgentConfig({
      agent_name: "explor_agent",
      display_name: "Explore Agent",
      description: "系统默认探索 Agent，负责搜索代码库、定位实现与归纳上下文。",
      system_prompt: "你负责快速探索仓库，定位相关文件、现有实现和可复用模式。",
    }),
    general_agent: buildSystemAgentConfig({
      agent_name: "general_agent",
      display_name: "General Agent",
      description: "系统默认通用执行 Agent，负责处理中等复杂度的综合实现与代码修改。",
      system_prompt: "你负责承接通用实现任务，优先复用现有代码模式，直接产出完成所需的最少改动。",
      tools: ["read_file", "write_file", "edit_file", "preview_data_structure", "execute_bash"],
      delegation: ["explor_agent"],
    }),
    review_agent: buildSystemAgentConfig({
      agent_name: "review_agent",
      display_name: "Review Agent",
      description: "系统默认评审 Agent，负责检查改动质量、复用性和潜在问题。",
      system_prompt: "你负责审查当前改动，聚焦正确性、复用性、一致性和不必要复杂度。",
      tools: ["read_file", "preview_data_structure", "execute_bash"],
    }),
    test_agent: buildSystemAgentConfig({
      agent_name: "test_agent",
      display_name: "Test Agent",
      description: "系统默认测试 Agent，负责运行验证命令并定位失败原因。",
      system_prompt: "你负责运行测试、构建和验证命令，准确报告失败点并归纳最直接的修复线索。",
      tools: ["read_file", "preview_data_structure", "execute_bash"],
    }),
  };
}

function buildSystemAgentConfig(input: {
  agent_name: string;
  display_name: string;
  description: string;
  system_prompt: string;
  default_entry?: boolean;
  tools?: string[];
  skills?: string[];
  delegation?: string[];
  tasks?: { workflow?: boolean; background?: boolean };
}): AgentConfig {
  return normalizeConfig({
    agent_name: input.agent_name,
    display_name: input.display_name,
    description: input.description,
    enabled: true,
    default_entry: input.default_entry ?? false,
    llm_tiers: { default: { ...defaultLlmTier } },
    tools: { enabled_tools: input.tools ?? ["read_file", "preview_data_structure"] },
    skills: { enabled_skills: input.skills ?? [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: ["team", "session"],
      write_scopes: ["session"],
      archive_scopes: ["session"],
    },
    tasks: { workflow: false, background: false, ...(input.tasks ?? {}) },
    delegation: { enabled_agents: input.delegation ?? [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: {
      type: "orchestrator",
      behavior: {
        system_prompt: input.system_prompt,
        compression_trigger_ratio: 0.85,
        summarize_max_tokens: 300,
        preserve_recent_turns: 3,
      },
    },
  });
}

function buildCustomAgentConfig(input: CreateAgentRequest): AgentConfig {
  const systemPrompt =
    getNestedString(input.custom_params, ["behavior", "system_prompt"]) ??
    `${input.display_name ?? input.agent_name} 是当前 team 中的自定义智能体。`;
  return normalizeConfig({
    agent_name: input.agent_name,
    display_name: input.display_name ?? input.agent_name,
    description: input.description ?? "",
    enabled: true,
    default_entry: input.default_entry ?? false,
    llm_tiers: { default: input.llm ? { ...input.llm } : { ...defaultLlmTier } },
    tools: { enabled_tools: ["read_file", "preview_data_structure"] },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: ["team", "session"],
      write_scopes: ["session"],
      archive_scopes: ["session"],
    },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: {
      type: "orchestrator",
      ...(input.custom_params ?? {}),
      behavior: {
        system_prompt: systemPrompt,
        compression_trigger_ratio: 0.85,
        summarize_max_tokens: 300,
        preserve_recent_turns: 3,
        ...(isRecord(input.custom_params?.behavior) ? input.custom_params.behavior : {}),
      },
    },
  });
}

function configToAgentInfo(config: AgentConfig): AgentInfo {
  return {
    name: config.agent_name,
    agent_name: config.agent_name,
    display_name: config.display_name ?? config.agent_name,
    description: config.description ?? null,
    capabilities: [],
    tools: config.tools?.enabled_tools ?? [],
    enabled: config.enabled,
    default_entry: config.default_entry,
    config: {
      enabled: config.enabled,
      llm_tiers: config.llm_tiers ?? null,
      custom_params: config.custom_params,
    },
  };
}

function configsToRecord(configs: TeamConfigs): Record<string, AgentConfig> {
  return Object.fromEntries(Array.from(configs.entries()).map(([name, config]) => [name, cloneConfig(config)]));
}

function cloneConfigMap(configs: TeamConfigs): TeamConfigs {
  return new Map(Array.from(configs.entries()).map(([name, config]) => [name, cloneConfig(config)]));
}

function cloneConfig(config: AgentConfig): AgentConfig {
  return structuredClone(config) as AgentConfig;
}

function normalizeConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    display_name: config.display_name ?? null,
    description: config.description ?? null,
    enabled: config.enabled ?? true,
    default_entry: config.default_entry ?? false,
    llm_tiers: config.llm_tiers ?? { default: { ...defaultLlmTier } },
    tools: config.tools ?? { enabled_tools: [] },
    skills: config.skills ?? { enabled_skills: [], auto_inject: true },
    mcp: config.mcp ?? { enabled_servers: [] },
    memory: config.memory ?? {
      auto_inject: true,
      allowed_scopes: ["team", "session"],
      write_scopes: ["session"],
      archive_scopes: ["session"],
    },
    tasks: config.tasks ?? { workflow: false, background: false },
    delegation: config.delegation ?? { enabled_agents: [] },
    knowledge_base: config.knowledge_base ?? {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: config.custom_params ?? {},
  };
}

function normalizeTeamName(teamName: string): string {
  const normalized = teamName.trim();
  if (!normalized) {
    throw new Error("team_name 不能为空");
  }
  return normalized;
}

function normalizeAgentName(agentName: string): string {
  const normalized = agentName.trim();
  if (!normalized) {
    throw new Error("智能体名称不能为空");
  }
  return normalized;
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current : undefined;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) {
    return patch === undefined ? base : patch;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = deepMerge(merged[key], value);
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
