import YAML from "yaml";

import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentInfo,
  type CreateAgentRequest,
  type TeamInfo,
  type TeamSummary,
} from "../../contracts/agent-config.js";
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
} from "./agent-config-service/configs.js";
import { AgentConfigTeamStore, defaultTeamRelativePath } from "./agent-config-service/team-store.js";
import { listAvailableTools as listAvailableRuntimeTools, type AvailableToolInfo } from "./agent-config-service/tools.js";
import { toYaml } from "./agent-config-service/yaml.js";
import type { SkillToolService } from "../../tools/SkillTools/SkillExecution.js";
import type { McpService } from "../integrations/mcp-service.js";

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
  private readonly teamStore: AgentConfigTeamStore;
  private readonly teamFileByName = new Map<string, string>();
  private skillToolService: SkillToolService | null = null;
  private mcpService: McpService | null = null;

  constructor(options: { dataRoot?: string | undefined; configRoot?: string | undefined } = {}) {
    this.teamStore = new AgentConfigTeamStore(options);
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
    this.teamFileByName.set(normalized, this.teamStore.nextTeamRelativePath(normalized, this.teamFileByName));
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
    const teamFile = this.teamFileByName.get(normalized);
    this.teams.delete(normalized);
    if (this.activeTeam === normalized) {
      this.activeTeam = Array.from(this.teams.keys())[0] ?? "default";
    }
    this.teamFileByName.delete(normalized);
    this.saveAll();
    this.teamStore.removeTeamFile(teamFile);
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
    const currentFile = this.teamFileByName.get(current) ?? defaultTeamRelativePath(current);
    this.teams.delete(current);
    this.teamFileByName.delete(current);
    this.teams.set(next, configs);
    const nextFile = current === next ? currentFile : this.teamStore.nextTeamRelativePath(next, this.teamFileByName);
    this.teamFileByName.set(next, nextFile);
    if (this.activeTeam === current) {
      this.activeTeam = next;
    }
    this.teamStore.renameTeamFile(currentFile, nextFile);
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
    this.teamFileByName.set("default", defaultTeamRelativePath("default"));
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
    const loaded = this.teamStore.loadTeams();
    if (!loaded) {
      return;
    }

    this.teams.clear();
    this.teamFileByName.clear();
    for (const [teamName, configs] of loaded.teams) {
      this.teams.set(teamName, configs);
    }
    for (const [teamName, teamFile] of loaded.teamFileByName) {
      this.teamFileByName.set(teamName, teamFile);
    }
    this.activeTeam = loaded.activeTeam;
  }

  private saveAll(): void {
    this.teamStore.saveAll(this.activeTeam, this.teams, this.teamFileByName);
  }

  private saveTeamIndex(): void {
    this.teamStore.saveTeamIndex(this.activeTeam, this.teams, this.teamFileByName);
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
