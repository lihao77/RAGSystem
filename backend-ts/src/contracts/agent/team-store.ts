import type { AgentConfig } from "./agent-config.js";

export type AgentConfigTeam = Map<string, AgentConfig>;

export interface LoadedAgentConfigTeams {
  activeTeam: string;
  teams: Map<string, AgentConfigTeam>;
}

/** Persistence boundary for the agent configuration application service. */
export interface IAgentConfigTeamStore {
  loadTeams(): Promise<LoadedAgentConfigTeams | null>;
  /** Persist active team index and every team config document. */
  saveAll(activeTeam: string, teams: Map<string, AgentConfigTeam>): Promise<void>;
  /** Persist only the team index (active team + location map). */
  saveIndex(activeTeam: string, teams: Map<string, AgentConfigTeam>): Promise<void>;
  removeTeam(teamName: string): Promise<void>;
  renameTeam(teamName: string, newTeamName: string): Promise<void>;
  getTeamLocation(teamName: string): Promise<string | null>;
}
