import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { AgentConfig } from "../../contracts/agent-config.js";
import { AgentConfigSchema } from "../../contracts/agent-config.js";
import {
  configsToRecord,
  isRecord,
  normalizeConfig,
  normalizeTeamName,
  type TeamConfigs,
} from "./configs.js";

const AGENT_CONFIG_RELATIVE_ROOT = path.join("config", "agents");
const AGENT_CONFIG_SCHEMA_VERSION = "2.0";
const TEAM_CONFIG_DIR_NAME = "teams";

export interface LoadedAgentConfigTeams {
  activeTeam: string;
  teams: Map<string, TeamConfigs>;
  teamFileByName: Map<string, string>;
}

export class AgentConfigTeamStore {
  private readonly configRoot: string | null;

  constructor(options: { dataRoot?: string | undefined; configRoot?: string | undefined } = {}) {
    this.configRoot = resolveAgentConfigRoot(options);
  }

  loadTeams(): LoadedAgentConfigTeams | null {
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

    const teams = new Map<string, TeamConfigs>();
    const teamFileByName = new Map<string, string>();
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
      teamFileByName.set(normalizedTeamName, teamFile);
    }
    if (teams.size === 0) {
      return null;
    }

    const activeTeam = typeof rawIndex.active_team === "string" ? rawIndex.active_team.trim() : "";
    return {
      activeTeam: activeTeam && teams.has(activeTeam) ? activeTeam : (Array.from(teams.keys()).sort()[0] ?? "default"),
      teams,
      teamFileByName,
    };
  }

  saveAll(activeTeam: string, teams: Map<string, TeamConfigs>, teamFileByName: Map<string, string>): void {
    if (!this.configRoot) {
      return;
    }
    this.saveTeamIndex(activeTeam, teams, teamFileByName);
    for (const teamName of teams.keys()) {
      this.saveTeam(teamName, teams, teamFileByName);
    }
  }

  saveTeamIndex(activeTeam: string, teamsByName: Map<string, TeamConfigs>, teamFileByName: Map<string, string>): void {
    if (!this.configRoot) {
      return;
    }
    fs.mkdirSync(this.configRoot, { recursive: true });
    const teams = Object.fromEntries(
      Array.from(teamsByName.keys()).map((teamName) => [
        teamName,
        teamFileByName.get(teamName) ?? defaultTeamRelativePath(teamName),
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

  saveTeam(teamName: string, teams: Map<string, TeamConfigs>, teamFileByName: Map<string, string>): void {
    if (!this.configRoot) {
      return;
    }
    const configs = teams.get(teamName);
    if (!configs) {
      return;
    }
    const teamFile = teamFileByName.get(teamName) ?? defaultTeamRelativePath(teamName);
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

  nextTeamRelativePath(teamName: string, teamFileByName: Map<string, string>): string {
    const basePath = defaultTeamRelativePath(teamName);
    if (!new Set(teamFileByName.values()).has(basePath)) {
      return basePath;
    }
    const extension = path.extname(basePath);
    const withoutExtension = basePath.slice(0, -extension.length);
    return `${withoutExtension}-${compactTimestamp(new Date())}${extension}`;
  }

  resolveTeamPath(teamFile: string | null | undefined): string | null {
    if (!this.configRoot || !teamFile) {
      return null;
    }
    return this.resolveRequiredTeamPath(teamFile);
  }

  removeTeamFile(teamFile: string | null | undefined): void {
    const teamPath = this.resolveTeamPath(teamFile);
    if (teamPath && fs.existsSync(teamPath)) {
      fs.rmSync(teamPath, { force: true });
    }
  }

  renameTeamFile(oldTeamFile: string | null | undefined, newTeamFile: string | null | undefined): void {
    const oldTeamPath = this.resolveTeamPath(oldTeamFile);
    const newTeamPath = this.resolveTeamPath(newTeamFile);
    if (!oldTeamPath || !newTeamPath || oldTeamPath === newTeamPath || !fs.existsSync(oldTeamPath)) {
      return;
    }
    fs.mkdirSync(path.dirname(newTeamPath), { recursive: true });
    fs.renameSync(oldTeamPath, newTeamPath);
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

function slugifyTeamName(teamName: string): string {
  const slug = teamName.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return slug || "default";
}

function compactTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
