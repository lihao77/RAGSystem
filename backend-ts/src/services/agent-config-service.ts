import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { AgentConfig, AgentInfo, CreateAgentRequest, TeamInfo, TeamSummary } from "../contracts/agent-config.js";
import { AgentConfigSchema } from "../contracts/agent-config.js";

type TeamConfigs = Map<string, AgentConfig>;
type ExportFormat = "json" | "yaml";
const AGENT_CONFIG_RELATIVE_ROOT = path.join("config", "agents");
const AGENT_CONFIG_SCHEMA_VERSION = "2.0";
const TEAM_CONFIG_DIR_NAME = "teams";

const agentConfigPresets = {
  fast: { temperature: 0.1, max_completion_tokens: 2048 },
  balanced: { temperature: 0.5, max_completion_tokens: 4096 },
  accurate: { temperature: 0.1, max_completion_tokens: 8192 },
  creative: { temperature: 0.9, max_completion_tokens: 4096 },
  cheap: { temperature: 0.5, max_completion_tokens: 2048 },
} as const;

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
  private readonly configRoot: string | null;
  private readonly teamFileByName = new Map<string, string>();

  constructor(options: { dataRoot?: string | undefined; configRoot?: string | undefined } = {}) {
    this.configRoot = resolveAgentConfigRoot(options);
    this.teams.set("default", new Map(Object.entries(buildDefaultAgentConfigs())));
    this.teamFileByName.set("default", defaultTeamRelativePath("default"));
    this.loadTeamsFromDisk();
  }

  listConfigs(options: { teamName?: string | null } = {}): Record<string, AgentConfig> {
    const configs = this.resolveConfigsForRead(options.teamName);
    return configs ? configsToRecord(configs) : {};
  }

  listAgents(): AgentInfo[] {
    return Array.from(this.getActiveConfigs().values())
      .map((config) => configToAgentInfo(config))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getConfig(agentName: string, options: { teamName?: string | null } = {}): AgentConfig | null {
    const configs = this.resolveConfigsForRead(options.teamName);
    const config = configs?.get(agentName);
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
    this.saveAll();
    return cloneConfig(config);
  }

  replaceConfig(agentName: string, payload: AgentConfig): AgentConfig {
    const config = normalizeConfig({
      ...payload,
      agent_name: agentName,
    });
    this.enforceSingleDefaultEntry(agentName, config.default_entry);
    this.getActiveConfigs().set(agentName, config);
    this.saveAll();
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
    this.saveAll();
    return cloneConfig(merged);
  }

  deleteConfig(agentName: string): boolean {
    const deleted = this.getActiveConfigs().delete(agentName);
    if (deleted) {
      this.saveAll();
    }
    return deleted;
  }

  listPresets(): Record<string, { temperature: number; max_completion_tokens: number }> {
    return structuredClone(agentConfigPresets);
  }

  applyPreset(agentName: string, presetName: string): AgentConfig | null {
    const config = this.getActiveConfigs().get(agentName);
    if (!config) {
      return null;
    }
    const preset = agentConfigPresets[presetName as keyof typeof agentConfigPresets];
    if (!preset) {
      throw new Error(`未知预设 '${presetName}'`);
    }

    const updated = normalizeConfig({
      ...cloneConfig(config),
      llm_tiers: Object.fromEntries(
        Object.entries(config.llm_tiers ?? { default: { ...defaultLlmTier } }).map(([tierName, llm]) => [
          tierName,
          {
            ...llm,
            temperature: preset.temperature,
            max_completion_tokens: preset.max_completion_tokens,
          },
        ]),
      ),
    });
    this.getActiveConfigs().set(agentName, updated);
    this.saveAll();
    return cloneConfig(updated);
  }

  exportConfig(agentName: string, format: ExportFormat): { content: string; contentType: string; fileExtension: string } | null {
    const config = this.getActiveConfigs().get(agentName);
    if (!config) {
      return null;
    }
    const cloned = cloneConfig(config);
    if (format === "json") {
      return {
        content: `${JSON.stringify(cloned, null, 2)}\n`,
        contentType: "application/json; charset=utf-8",
        fileExtension: "json",
      };
    }
    return {
      content: toYaml(cloned),
      contentType: "application/x-yaml; charset=utf-8",
      fileExtension: "yaml",
    };
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
    const deleted = this.getActiveConfigs().delete(normalized);
    if (deleted) {
      this.saveAll();
    }
    return deleted;
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
    this.teamFileByName.set(normalized, this.nextTeamRelativePath(normalized));
    this.saveAll();
    return this.listTeams();
  }

  activateTeam(teamName: string): TeamSummary {
    const normalized = normalizeTeamName(teamName);
    this.getTeamConfigs(normalized);
    this.activeTeam = normalized;
    this.saveTeamIndex();
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
    const teamFile = this.resolveTeamPath(normalized);
    this.teams.delete(normalized);
    if (this.activeTeam === normalized) {
      this.activeTeam = Array.from(this.teams.keys())[0] ?? "default";
    }
    this.teamFileByName.delete(normalized);
    this.saveAll();
    if (teamFile && fs.existsSync(teamFile)) {
      fs.rmSync(teamFile, { force: true });
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
    const oldTeamPath = this.resolveTeamPath(current);
    const currentFile = this.teamFileByName.get(current) ?? defaultTeamRelativePath(current);
    this.teams.delete(current);
    this.teamFileByName.delete(current);
    this.teams.set(next, configs);
    this.teamFileByName.set(next, current === next ? currentFile : this.nextTeamRelativePath(next));
    if (this.activeTeam === current) {
      this.activeTeam = next;
    }
    const newTeamPath = this.resolveTeamPath(next);
    if (oldTeamPath && newTeamPath && oldTeamPath !== newTeamPath && fs.existsSync(oldTeamPath)) {
      fs.mkdirSync(path.dirname(newTeamPath), { recursive: true });
      fs.renameSync(oldTeamPath, newTeamPath);
    }
    this.saveAll();
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
    this.saveAll();
    return this.listTeams();
  }

  resetDefaultTeam(): TeamSummary {
    this.teams.set("default", new Map(Object.entries(buildDefaultAgentConfigs())));
    this.teamFileByName.set("default", defaultTeamRelativePath("default"));
    if (!this.teams.has(this.activeTeam)) {
      this.activeTeam = "default";
    }
    this.saveAll();
    return this.listTeams();
  }

  listAvailableTools(): Array<{
    name: string;
    description: string;
    category: string;
    runtime_status: "implemented" | "not_migrated";
    implemented: boolean;
    risk_level: "low" | "medium" | "high";
  }> {
    return [
      implementedTool("read_file", "Read a file from the managed workspace", "filesystem", "low"),
      implementedTool("write_file", "Write a file in the managed workspace", "filesystem", "high"),
      implementedTool("edit_file", "Edit an existing file in the managed workspace", "filesystem", "high"),
      implementedTool("preview_data_structure", "Preview structured data files", "data", "low"),
      implementedTool("execute_bash", "Execute a foreground shell command with approval boundaries", "execution", "high"),
      implementedTool("call_agent", "Delegate a subtask to an allowed child Agent", "agent_delegation", "low"),
      implementedTool("list_child_agents", "List child Agent sessions for the current session", "agent_delegation", "low"),
      implementedTool("send_message", "Continue an existing child Agent session", "agent_delegation", "low"),
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

  private resolveConfigsForRead(teamName?: string | null): TeamConfigs | null {
    const normalized = teamName?.trim();
    if (!normalized) {
      return this.getActiveConfigs();
    }
    return this.teams.get(normalized) ?? null;
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
      file_path: this.teamFileByName.get(teamName) ?? defaultTeamRelativePath(teamName),
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

  private loadTeamsFromDisk(): void {
    if (!this.configRoot) {
      return;
    }
    const teamIndexPath = path.join(this.configRoot, "team_index.yaml");
    if (!fs.existsSync(teamIndexPath)) {
      return;
    }
    const rawIndex = YAML.parse(fs.readFileSync(teamIndexPath, "utf8")) as unknown;
    if (!isRecord(rawIndex) || !isRecord(rawIndex.teams)) {
      return;
    }

    const loadedTeams = new Map<string, TeamConfigs>();
    const loadedTeamFiles = new Map<string, string>();
    for (const [teamName, teamPathValue] of Object.entries(rawIndex.teams)) {
      const normalizedTeamName = normalizeTeamName(teamName);
      const teamFile = typeof teamPathValue === "string" && teamPathValue.trim()
        ? teamPathValue.trim()
        : defaultTeamRelativePath(normalizedTeamName);
      const teamPath = path.isAbsolute(teamFile) ? teamFile : path.join(this.configRoot, teamFile);
      const configs = loadTeamConfigFile(teamPath);
      if (!configs) {
        continue;
      }
      loadedTeams.set(normalizedTeamName, configs);
      loadedTeamFiles.set(normalizedTeamName, teamFile);
    }
    if (loadedTeams.size === 0) {
      return;
    }

    this.teams.clear();
    this.teamFileByName.clear();
    for (const [teamName, configs] of loadedTeams) {
      this.teams.set(teamName, configs);
    }
    for (const [teamName, teamFile] of loadedTeamFiles) {
      this.teamFileByName.set(teamName, teamFile);
    }
    const activeTeam = typeof rawIndex.active_team === "string" ? rawIndex.active_team.trim() : "";
    this.activeTeam = activeTeam && this.teams.has(activeTeam) ? activeTeam : (Array.from(this.teams.keys()).sort()[0] ?? "default");
  }

  private saveAll(): void {
    if (!this.configRoot) {
      return;
    }
    this.saveTeamIndex();
    for (const teamName of this.teams.keys()) {
      this.saveTeam(teamName);
    }
  }

  private saveTeamIndex(): void {
    if (!this.configRoot) {
      return;
    }
    fs.mkdirSync(this.configRoot, { recursive: true });
    const teams = Object.fromEntries(
      Array.from(this.teams.keys()).map((teamName) => [
        teamName,
        this.teamFileByName.get(teamName) ?? defaultTeamRelativePath(teamName),
      ]),
    );
    fs.writeFileSync(
      path.join(this.configRoot, "team_index.yaml"),
      YAML.stringify({
        active_team: this.activeTeam,
        teams,
        metadata: {
          updated_at: new Date().toISOString(),
          version: AGENT_CONFIG_SCHEMA_VERSION,
        },
      }),
      "utf8",
    );
  }

  private saveTeam(teamName: string): void {
    if (!this.configRoot) {
      return;
    }
    const configs = this.getTeamConfigs(teamName);
    const teamFile = this.teamFileByName.get(teamName) ?? defaultTeamRelativePath(teamName);
    const teamPath = path.isAbsolute(teamFile) ? teamFile : path.join(this.configRoot, teamFile);
    fs.mkdirSync(path.dirname(teamPath), { recursive: true });
    fs.writeFileSync(
      teamPath,
      YAML.stringify({
        agents: configsToRecord(configs),
        metadata: {
          updated_at: new Date().toISOString(),
          version: AGENT_CONFIG_SCHEMA_VERSION,
        },
      }),
      "utf8",
    );
  }

  private nextTeamRelativePath(teamName: string): string {
    const basePath = defaultTeamRelativePath(teamName);
    if (!new Set(this.teamFileByName.values()).has(basePath)) {
      return basePath;
    }
    const extension = path.extname(basePath);
    const withoutExtension = basePath.slice(0, -extension.length);
    return `${withoutExtension}-${compactTimestamp(new Date())}${extension}`;
  }

  private resolveTeamPath(teamName: string): string | null {
    if (!this.configRoot) {
      return null;
    }
    const teamFile = this.teamFileByName.get(teamName);
    if (!teamFile) {
      return null;
    }
    return path.isAbsolute(teamFile) ? teamFile : path.join(this.configRoot, teamFile);
  }
}

function resolveAgentConfigRoot(options: { dataRoot?: string | undefined; configRoot?: string | undefined }): string | null {
  if (options.configRoot !== undefined) {
    const trimmed = options.configRoot.trim();
    return trimmed ? path.resolve(trimmed) : null;
  }
  if (!options.dataRoot?.trim()) {
    return null;
  }
  return path.join(path.resolve(options.dataRoot), AGENT_CONFIG_RELATIVE_ROOT);
}

function loadTeamConfigFile(teamPath: string): TeamConfigs | null {
  if (!fs.existsSync(teamPath)) {
    return null;
  }
  const rawTeam = YAML.parse(fs.readFileSync(teamPath, "utf8")) as unknown;
  if (!isRecord(rawTeam) || !isRecord(rawTeam.agents)) {
    return null;
  }
  const configs = new Map<string, AgentConfig>();
  for (const [agentName, value] of Object.entries(rawTeam.agents)) {
    if (!isRecord(value)) {
      continue;
    }
    const parsed = AgentConfigSchema.safeParse({
      ...value,
      agent_name: typeof value.agent_name === "string" && value.agent_name.trim() ? value.agent_name : agentName,
    });
    if (parsed.success) {
      const config = normalizeConfig(parsed.data);
      configs.set(config.agent_name, config);
    }
  }
  return configs.size > 0 ? configs : null;
}

function defaultTeamRelativePath(teamName: string): string {
  return `${TEAM_CONFIG_DIR_NAME}/${slugifyTeamName(teamName)}.yaml`;
}

function slugifyTeamName(teamName: string): string {
  const slug = teamName.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return slug || "default";
}

function compactTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
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

function implementedTool(
  name: string,
  description: string,
  category: string,
  riskLevel: "low" | "medium" | "high",
): {
  name: string;
  description: string;
  category: string;
  runtime_status: "implemented";
  implemented: true;
  risk_level: "low" | "medium" | "high";
} {
  return {
    name,
    description,
    category,
    runtime_status: "implemented",
    implemented: true,
    risk_level: riskLevel,
  };
}

function notMigratedTool(
  name: string,
  description: string,
  category: string,
  riskLevel: "low" | "medium" | "high",
): {
  name: string;
  description: string;
  category: string;
  runtime_status: "not_migrated";
  implemented: false;
  risk_level: "low" | "medium" | "high";
} {
  return {
    name,
    description,
    category,
    runtime_status: "not_migrated",
    implemented: false,
    risk_level: riskLevel,
  };
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

function toYaml(value: unknown): string {
  return `${yamlValue(value, 0)}\n`;
}

function yamlValue(value: unknown, indent: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return value.map((item) => yamlArrayItem(item, indent)).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    return entries.map(([key, item]) => yamlObjectEntry(key, item, indent)).join("\n");
  }
  return yamlScalar(value);
}

function yamlObjectEntry(key: string, value: unknown, indent: number): string {
  const prefix = `${" ".repeat(indent)}${key}:`;
  if (Array.isArray(value)) {
    return value.length === 0 ? `${prefix} []` : `${prefix}\n${yamlValue(value, indent + 2)}`;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0 ? `${prefix} {}` : `${prefix}\n${yamlValue(value, indent + 2)}`;
  }
  return `${prefix} ${yamlScalar(value)}`;
}

function yamlArrayItem(value: unknown, indent: number): string {
  const prefix = `${" ".repeat(indent)}-`;
  if (Array.isArray(value)) {
    return value.length === 0 ? `${prefix} []` : `${prefix}\n${yamlValue(value, indent + 2)}`;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0 ? `${prefix} {}` : `${prefix}\n${yamlValue(value, indent + 2)}`;
  }
  return `${prefix} ${yamlScalar(value)}`;
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}
