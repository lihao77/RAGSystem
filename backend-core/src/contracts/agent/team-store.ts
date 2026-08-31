import type { AgentConfig } from "./agent-config.js";
import type { AppliedHydrationStep } from "../../services/config/hydration.js";

export type AgentConfigTeam = Map<string, AgentConfig>;

export interface LoadedAgentConfigTeams {
  activeTeam: string;
  teams: Map<string, AgentConfigTeam>;
}

/** Persistence boundary for the agent configuration application service. */
export interface IAgentConfigTeamStore {
  loadTeams(): Promise<LoadedAgentConfigTeams | null>;
  /**
   * Persist active team index and every team config document.
   * 可选的应用记录（迁移链中实际改动了数据的步骤）：仅随迁移回写传入，由持久层
   * 决定落盘方式（local 写 sidecar；SaaS 当前 no-op，见 backend-core/MIGRATIONS.md）。
   */
  saveAll(
    activeTeam: string,
    teams: Map<string, AgentConfigTeam>,
    appliedMigrations?: readonly AppliedHydrationStep[],
  ): Promise<void>;
  /** Persist only the team index (active team + location map). */
  saveIndex(activeTeam: string, teams: Map<string, AgentConfigTeam>): Promise<void>;
  removeTeam(teamName: string): Promise<void>;
  renameTeam(teamName: string, newTeamName: string): Promise<void>;
  getTeamLocation(teamName: string): Promise<string | null>;
}
