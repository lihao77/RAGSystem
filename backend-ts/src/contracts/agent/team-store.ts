import type { AgentConfig } from "./agent-config.js";

export type AgentConfigTeam = Map<string, AgentConfig>;

export interface LoadedAgentConfigTeams {
  activeTeam: string;
  teams: Map<string, AgentConfigTeam>;
}

/** Persistence boundary for the agent configuration application service. */
export interface IAgentConfigTeamStore {
  loadTeams(): LoadedAgentConfigTeams | null;
  /** Persist active team index and every team config document. */
  saveAll(activeTeam: string, teams: Map<string, AgentConfigTeam>): void;
  /** Persist only the team index (active team + location map). */
  saveIndex(activeTeam: string, teams: Map<string, AgentConfigTeam>): void;
  removeTeam(teamName: string): void;
  renameTeam(teamName: string, newTeamName: string): void;
  getTeamLocation(teamName: string): string | null;
}
