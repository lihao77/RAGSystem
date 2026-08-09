import { AgentConfigSchema, type AgentConfig } from "../src/contracts/agent/agent-config.js";
import { computeSessionTeamRevision, type SessionTeamSnapshot } from "../src/contracts/session/session.js";

export function createTestTeamSnapshot(
  entryAgentName = "orchestrator_agent",
  configs: AgentConfig[] = [AgentConfigSchema.parse({ agent_name: entryAgentName })],
): SessionTeamSnapshot {
  const agents = Object.fromEntries(configs.map((config) => [config.agent_name, config]));
  return {
    team_name: "test-team",
    team_revision: computeSessionTeamRevision(agents),
    entry_agent_name: entryAgentName,
    agents,
  };
}
