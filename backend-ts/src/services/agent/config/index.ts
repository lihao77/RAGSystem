import YAML from "yaml";

import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentInfo,
  type CreateAgentRequest,
  type TeamInfo,
  type TeamSummary,
} from "../../../contracts/agent/agent-config.js";
import {
  agentConfigPresets,
  buildCustomAgentConfig,
  buildDefaultAgentConfigs,
  cloneConfig,
  cloneConfigMap,
  configToAgentInfo,
  configsToRecord,
  deepMerge,
  defaultLlmTier,
  isRecord,
  normalizeAgentName,
  normalizeConfig,
  normalizeTeamName,
  type TeamConfigs,
} from "./configs.js";
import type { IAgentConfigTeamStore } from "../../../contracts/agent/team-store.js";
import { listAvailableTools as listAvailableRuntimeTools, type AvailableToolInfo } from "./tools.js";
import { toYaml } from "./yaml.js";
import type { SkillToolService } from "../../../tools/SkillTools/SkillExecution.js";
import type { McpService } from "../../integrations/mcp-service.js";

type ExportFormat = "json" | "yaml";
type ImportFormat = "json" | "yaml";

export interface ApplyTeamPayloadResult {
  team_name: string;
  agent_count: number;
  agents: string[];
  source_team: string | null;
}

export class AgentConfigService {
  private activeTeam = "default";
  private readonly teams = new Map<string, TeamConfigs>();
  private readonly teamStore: IAgentConfigTeamStore;
  private skillToolService: SkillToolService | null = null;
  private mcpService: McpService | null = null;

  constructor(teamStore: IAgentConfigTeamStore) {
    this.teamStore = teamStore;
    this.teams.set("default", new Map(Object.entries(buildDefaultAgentConfigs())));
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
      this.purgeAgentReferences(agentName);
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

  importConfig(body: unknown, options: { formatName?: string | null; contentType?: string | undefined } = {}): AgentConfig {
    const format = resolveImportFormat(options.formatName, options.contentType);
    const parsed = parseImportBody(body, format);
    const config = normalizeConfig(AgentConfigSchema.parse(parsed));
    this.enforceSingleDefaultEntry(config.agent_name, config.default_entry);
    this.getActiveConfigs().set(config.agent_name, config);
    this.saveAll();
    return cloneConfig(config);
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
      this.purgeAgentReferences(normalized);
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
    this.saveAll();
    return this.listTeams();
  }

  activateTeam(teamName: string): TeamSummary {
    const normalized = normalizeTeamName(teamName);
    this.getTeamConfigs(normalized);
    this.activeTeam = normalized;
    this.teamStore.saveIndex(this.activeTeam, this.teams);
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
      this.activeTeam = Array.from(this.teams.keys())[0] ?? "default";
    }
    this.teamStore.removeTeam(normalized);
    this.saveAll();
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
    if (current !== next) {
      this.teamStore.renameTeam(current, next);
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

  applyTeamPayload(
    teamName: string,
    agentsPayload: Record<string, unknown>,
    sourceTeam?: string | null,
  ): ApplyTeamPayloadResult {
    const normalizedTeamName = normalizeTeamName(teamName);
    if (Object.keys(agentsPayload).length === 0) {
      throw new Error("agents_payload 必须是非空对象");
    }
    const normalizedSourceTeam = sourceTeam?.trim() || null;
    if (normalizedSourceTeam && !this.teams.has(normalizedSourceTeam)) {
      throw new Error(`source team '${normalizedSourceTeam}' 不存在`);
    }
    if (!this.teams.has(normalizedTeamName)) {
      this.createTeam(normalizedTeamName, normalizedSourceTeam);
    }

    const nextConfigs = new Map<string, AgentConfig>();
    const defaultEntries: string[] = [];
    for (const [agentName, payload] of Object.entries(agentsPayload)) {
      if (!isRecord(payload)) {
        throw new Error(`智能体 '${agentName}' 的配置必须是对象`);
      }
      const parsed = AgentConfigSchema.parse({
        ...payload,
        agent_name: payload.agent_name ?? agentName,
      });
      if (parsed.agent_name !== agentName) {
        throw new Error(`智能体键名 '${agentName}' 与配置中的 agent_name '${parsed.agent_name}' 不一致`);
      }
      const config = normalizeConfig(parsed);
      if (config.default_entry) {
        defaultEntries.push(agentName);
      }
      nextConfigs.set(agentName, config);
    }
    if (defaultEntries.length > 1) {
      throw new Error(`default_entry=true 只能有一个，当前: ${defaultEntries.join(", ")}`);
    }

    this.teams.set(normalizedTeamName, nextConfigs);
    this.saveAll();
    return {
      team_name: normalizedTeamName,
      agent_count: nextConfigs.size,
      agents: Array.from(nextConfigs.keys()).sort(),
      source_team: normalizedSourceTeam,
    };
  }

  resetDefaultTeam(): TeamSummary {
    this.teams.set("default", new Map(Object.entries(buildDefaultAgentConfigs())));
    if (!this.teams.has(this.activeTeam)) {
      this.activeTeam = "default";
    }
    this.saveAll();
    return this.listTeams();
  }

  listAvailableTools(): AvailableToolInfo[] {
    return listAvailableRuntimeTools();
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
    return this.mcpService?.listServers() ?? [];
  }

  listAvailableSkills(): unknown[] {
    return this.skillToolService?.listAvailableSkills() ?? [];
  }

  /**
   * 删除 skill 时联动清理所有 team 的 agent 对其的 enabled_skills 引用，
   * 消除悬空引用（skill 本体已删，配置里不能再留着名字导致 snapshot/可见性误判）。
   * 返回受影响的 `team/agent` 列表。
   */
  purgeSkillReference(skillName: string): string[] {
    const updated: string[] = [];
    for (const [teamName, configs] of this.teams) {
      for (const [agentName, config] of configs) {
        const enabled = config.skills?.enabled_skills;
        if (!enabled?.length || !enabled.includes(skillName)) continue;
        configs.set(agentName, {
          ...config,
          skills: {
            ...config.skills,
            enabled_skills: enabled.filter((name) => name !== skillName),
          },
        });
        updated.push(`${teamName}/${agentName}`);
      }
    }
    if (updated.length) {
      this.saveAll();
    }
    return updated;
  }

  setSkillToolService(skillToolService: SkillToolService | null): void {
    this.skillToolService = skillToolService;
  }

  setMcpService(mcpService: McpService | null): void {
    this.mcpService = mcpService;
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
      file_path: this.teamStore.getTeamLocation(teamName) ?? "",
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

  /** 删除 agent 后，级联清理当前 team 内其余 agent 对它的委派引用，避免悬空 enabled_agents 条目。 */
  private purgeAgentReferences(agentName: string): void {
    const configs = this.getActiveConfigs();
    for (const [name, config] of configs) {
      if (name === agentName) continue;
      const enabledAgents = config.delegation?.enabled_agents;
      if (!enabledAgents?.length || !enabledAgents.includes(agentName)) continue;
      configs.set(name, {
        ...config,
        delegation: {
          ...config.delegation,
          enabled_agents: enabledAgents.filter((target) => target !== agentName),
        },
      });
    }
  }

  private loadTeamsFromDisk(): void {
    const loaded = this.teamStore.loadTeams();
    if (!loaded) {
      return;
    }

    this.teams.clear();
    for (const [teamName, configs] of loaded.teams) {
      this.teams.set(teamName, configs);
    }
    this.activeTeam = loaded.activeTeam;
    // 自愈历史脏数据：剔除 enabled_agents 中指向本 team 不存在 agent 的悬空引用，改动一次性回写磁盘。
    if (this.normalizeTeamReferences()) {
      this.saveAll();
    }
  }

  /** 规整所有 team 的委派引用：剔除指向本 team 不存在 agent 的 enabled_agents 条目。返回是否有改动。 */
  private normalizeTeamReferences(): boolean {
    let changed = false;
    for (const configs of this.teams.values()) {
      const members = new Set(configs.keys());
      for (const [name, config] of configs) {
        const enabledAgents = config.delegation?.enabled_agents;
        if (!enabledAgents?.length) continue;
        const next = enabledAgents.filter((target) => members.has(target));
        if (next.length === enabledAgents.length) continue;
        changed = true;
        configs.set(name, {
          ...config,
          delegation: { ...config.delegation, enabled_agents: next },
        });
      }
    }
    return changed;
  }

  private saveAll(): void {
    this.teamStore.saveAll(this.activeTeam, this.teams);
  }
}

function resolveImportFormat(formatName: string | null | undefined, contentType: string | undefined): ImportFormat {
  const requested = formatName?.trim().toLowerCase();
  if (requested) {
    if (requested === "yaml" || requested === "yml") {
      return "yaml";
    }
    if (requested === "json") {
      return "json";
    }
    throw new Error("format 只支持 json 或 yaml");
  }

  const normalizedContentType = (contentType ?? "").toLowerCase();
  if (normalizedContentType.includes("json")) {
    return "json";
  }
  return "yaml";
}

function parseImportBody(body: unknown, format: ImportFormat): unknown {
  if (isRecord(body)) {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return parseImportText(body.toString("utf8"), format);
  }
  if (typeof body === "string") {
    return parseImportText(body, format);
  }
  if (body === null || body === undefined) {
    return {};
  }
  return body;
}

function parseImportText(text: string, format: ImportFormat): unknown {
  if (format === "json") {
    return JSON.parse(text);
  }
  return YAML.parse(text) ?? {};
}
