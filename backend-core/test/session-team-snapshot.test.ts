import { describe, expect, it } from "vitest";

import { TeamSelectionError } from "../src/contracts/agent/agent-config.js";
import type { AgentConfigTeam, IAgentConfigTeamStore } from "../src/contracts/agent/team-store.js";
import { normalizeSessionMetadata, SessionTeamSnapshotSchema } from "../src/contracts/session/session.js";
import { AgentConfigService } from "../src/services/agent/config/index.js";

class MemoryTeamStore implements IAgentConfigTeamStore {
  async loadTeams() { return null; }
  async saveAll(_activeTeam: string, _teams: Map<string, AgentConfigTeam>) {}
  async saveIndex(_activeTeam: string, _teams: Map<string, AgentConfigTeam>) {}
  async removeTeam(_teamName: string) {}
  async renameTeam(_teamName: string, _newTeamName: string) {}
  async getTeamLocation() { return null; }
}

describe("Session Team snapshots", () => {
  it("keeps an existing snapshot immutable when its source Team changes", async () => {
    const service = new AgentConfigService(new MemoryTeamStore());
    await service.initialize();
    const first = service.createTeamSnapshot();

    await service.patchConfig("orchestrator_agent", { display_name: "Changed Orchestrator" });
    const second = service.createTeamSnapshot();

    expect(first.team_name).toBe("default");
    expect(first.entry_agent_name).toBe("orchestrator_agent");
    expect(first.team_revision).not.toBe(second.team_revision);
    expect(first.agents.orchestrator_agent?.display_name).not.toBe("Changed Orchestrator");
    expect(second.agents.orchestrator_agent?.display_name).toBe("Changed Orchestrator");
  });

  it("rejects legacy Team routing hidden in free-form Session metadata", () => {
    expect(() => normalizeSessionMetadata({ team: "default" })).toThrow(/保留字段/);
    expect(() => normalizeSessionMetadata({ entry_agent: "orchestrator_agent" })).toThrow(/保留字段/);
  });

  it("rejects a revision that does not cover the complete Agent snapshot", async () => {
    const service = new AgentConfigService(new MemoryTeamStore());
    await service.initialize();
    const snapshot = service.createTeamSnapshot();
    expect(() => SessionTeamSnapshotSchema.parse({
      ...snapshot,
      team_revision: "0".repeat(64),
    })).toThrow(/revision does not match/);
  });

  it("classifies invalid Team selections as client input errors", async () => {
    const service = new AgentConfigService(new MemoryTeamStore());
    await service.initialize();
    expect(() => service.createTeamSnapshot({ teamName: "missing" })).toThrow(TeamSelectionError);
    expect(() => service.createTeamSnapshot({ entryAgentName: "missing" })).toThrow(TeamSelectionError);
  });
});
