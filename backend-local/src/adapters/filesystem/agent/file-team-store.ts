import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import { AgentConfigSchema } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import {
  configsToRecord,
  normalizeConfig,
  normalizeTeamName,
} from "@ragsystem/backend-core/contracts/agent/config-normalize.js";
import type { AgentConfigTeam, IAgentConfigTeamStore, LoadedAgentConfigTeams } from "@ragsystem/backend-core/contracts/agent/team-store.js";
import type { AppliedHydrationStep } from "@ragsystem/backend-core/services/config/hydration.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

const AGENT_CONFIG_RELATIVE_ROOT = path.join("config", "agents");
const AGENT_CONFIG_SCHEMA_VERSION = "2.0";
const TEAM_CONFIG_DIR_NAME = "teams";

export class FileAgentConfigTeamStore implements IAgentConfigTeamStore {
  private readonly configRoot: string | null;
  private readonly teamFileByName = new Map<string, string>();

  constructor(options: { dataRoot?: string | undefined; configRoot?: string | undefined } = {}) {
    this.configRoot = resolveAgentConfigRoot(options);
  }

  async loadTeams(): Promise<LoadedAgentConfigTeams | null> {
    if (!this.configRoot) {
      return null;
    }
    const teamIndexPath = path.join(this.configRoot, "team_index.yaml");
    if (!fs.existsSync(teamIndexPath)) {
      return null;
    }
    const rawIndex = YAML.parse(fs.readFileSync(teamIndexPath, "utf8")) as unknown;
    if (!isRecord(rawIndex) || !isRecord(rawIndex.teams)) {
      return null;
    }

    const teams = new Map<string, AgentConfigTeam>();
    this.teamFileByName.clear();
    for (const [teamName, teamPathValue] of Object.entries(rawIndex.teams)) {
      const normalizedTeamName = normalizeTeamName(teamName);
      const teamFile = typeof teamPathValue === "string" && teamPathValue.trim()
        ? teamPathValue.trim()
        : defaultTeamRelativePath(normalizedTeamName);
      const configs = loadTeamConfigFile(this.resolveRequiredTeamPath(teamFile));
      if (!configs) {
        continue;
      }
      teams.set(normalizedTeamName, configs);
      this.teamFileByName.set(normalizedTeamName, teamFile);
    }
    if (teams.size === 0) {
      return null;
    }

    const activeTeam = typeof rawIndex.active_team === "string" ? rawIndex.active_team.trim() : "";
    return {
      activeTeam: activeTeam && teams.has(activeTeam) ? activeTeam : (Array.from(teams.keys()).sort()[0] ?? "default"),
      teams,
    };
  }

  async saveAll(
    activeTeam: string,
    teams: Map<string, AgentConfigTeam>,
    appliedMigrations?: readonly AppliedHydrationStep[],
  ): Promise<void> {
    if (!this.configRoot) {
      return;
    }
    this.ensureTeamLocations(teams);
    this.saveTeamIndex(activeTeam, teams);
    for (const teamName of teams.keys()) {
      this.saveTeam(teamName, teams);
    }
    // 应用戳仅随迁移回写（干净数据不会有传值）；写失败只影响审计可见性，不阻断配置回写。
    if (appliedMigrations?.length) {
      this.appendMigrationStamp(appliedMigrations);
    }
  }

  /**
   * 追加迁移应用记录到 config/agents/.migrations.json（追加式历史，含 applied_at，
   * 上限截断防无限增长）。纯审计用途：读取方为人工排查，加载路径不依赖它。
   */
  private appendMigrationStamp(applied: readonly AppliedHydrationStep[]): void {
    if (!this.configRoot) {
      return;
    }
    try {
      const stampPath = path.join(this.configRoot, ".migrations.json");
      const entries: AppliedHydrationStep[] = [];
      if (fs.existsSync(stampPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(stampPath, "utf8")) as unknown;
          if (Array.isArray(parsed)) {
            entries.push(...parsed.filter(isAppliedHydrationStep));
          }
        } catch {
          // 损坏的 sidecar 重建为只含本次记录的干净历史（纯审计数据，可弃不可信）。
        }
      }
      entries.push(...applied.map((item) => ({ ...item })));
      fs.mkdirSync(this.configRoot, { recursive: true });
      fs.writeFileSync(stampPath, JSON.stringify(entries.slice(-200), null, 2), "utf8");
    } catch {
      // 戳是尽力而为的审计痕迹：损坏/权限失败不阻断配置持久化与后续加载。
    }
  }

  async saveIndex(activeTeam: string, teams: Map<string, AgentConfigTeam>): Promise<void> {
    if (!this.configRoot) {
      return;
    }
    this.ensureTeamLocations(teams);
    this.saveTeamIndex(activeTeam, teams);
  }

  private ensureTeamLocations(teams: Map<string, AgentConfigTeam>): void {
    for (const teamName of teams.keys()) {
      if (!this.teamFileByName.has(teamName)) {
        this.teamFileByName.set(teamName, this.nextTeamRelativePath(teamName));
      }
    }
  }

  private saveTeamIndex(activeTeam: string, teamsByName: Map<string, AgentConfigTeam>): void {
    if (!this.configRoot) {
      return;
    }
    fs.mkdirSync(this.configRoot, { recursive: true });
    const teams = Object.fromEntries(
      Array.from(teamsByName.keys()).map((teamName) => [
        teamName,
        this.teamFileByName.get(teamName) ?? defaultTeamRelativePath(teamName),
      ]),
    );
    fs.writeFileSync(
      path.join(this.configRoot, "team_index.yaml"),
      YAML.stringify({
        active_team: activeTeam,
        teams,
        metadata: {
          updated_at: new Date().toISOString(),
          version: AGENT_CONFIG_SCHEMA_VERSION,
        },
      }),
      "utf8",
    );
  }

  private saveTeam(teamName: string, teams: Map<string, AgentConfigTeam>): void {
    if (!this.configRoot) {
      return;
    }
    const configs = teams.get(teamName);
    if (!configs) {
      return;
    }
    const teamFile = this.teamFileByName.get(teamName) ?? defaultTeamRelativePath(teamName);
    const teamPath = this.resolveRequiredTeamPath(teamFile);
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

  private resolveTeamPath(teamFile: string | null | undefined): string | null {
    if (!this.configRoot || !teamFile) {
      return null;
    }
    return this.resolveRequiredTeamPath(teamFile);
  }

  async removeTeam(teamName: string): Promise<void> {
    const teamFile = this.teamFileByName.get(teamName);
    const teamPath = this.resolveTeamPath(teamFile);
    if (teamPath && fs.existsSync(teamPath)) {
      fs.rmSync(teamPath, { force: true });
    }
    this.teamFileByName.delete(teamName);
  }

  async renameTeam(teamName: string, newTeamName: string): Promise<void> {
    const oldTeamFile = this.teamFileByName.get(teamName) ?? defaultTeamRelativePath(teamName);
    const newTeamFile = this.nextTeamRelativePath(newTeamName);
    const oldTeamPath = this.resolveTeamPath(oldTeamFile);
    const newTeamPath = this.resolveTeamPath(newTeamFile);
    if (!oldTeamPath || !newTeamPath || oldTeamPath === newTeamPath || !fs.existsSync(oldTeamPath)) {
      this.teamFileByName.delete(teamName);
      this.teamFileByName.set(newTeamName, newTeamFile);
      return;
    }
    fs.mkdirSync(path.dirname(newTeamPath), { recursive: true });
    fs.renameSync(oldTeamPath, newTeamPath);
    this.teamFileByName.delete(teamName);
    this.teamFileByName.set(newTeamName, newTeamFile);
  }

  async getTeamLocation(teamName: string): Promise<string | null> {
    if (!this.configRoot) {
      return null;
    }
    return this.teamFileByName.get(teamName) ?? defaultTeamRelativePath(teamName);
  }

  private resolveRequiredTeamPath(teamFile: string): string {
    if (!this.configRoot) {
      throw new Error("agent config root is disabled");
    }
    return path.isAbsolute(teamFile) ? teamFile : path.join(this.configRoot, teamFile);
  }
}

export function defaultTeamRelativePath(teamName: string): string {
  return `${TEAM_CONFIG_DIR_NAME}/${slugifyTeamName(teamName)}.yaml`;
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

function loadTeamConfigFile(teamPath: string): AgentConfigTeam | null {
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

function slugifyTeamName(teamName: string): string {
  const slug = teamName.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return slug || "default";
}

function isAppliedHydrationStep(value: unknown): value is AppliedHydrationStep {
  return isRecord(value)
    && typeof value.id === "string" && value.id.trim().length > 0
    && typeof value.applied_at === "string" && value.applied_at.trim().length > 0;
}

function compactTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
