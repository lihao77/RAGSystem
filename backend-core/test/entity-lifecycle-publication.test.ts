import { describe, expect, it } from "vitest";

import type { AgentConfigTeam, IAgentConfigTeamStore } from "../src/contracts/agent/team-store.js";
import type { AgentSessionRepositoryPort } from "../src/contracts/session/agent-session-repository.js";
import {
  AGENT_DELETED_EVENT,
  SESSION_DELETED_EVENT,
  TEAM_DELETED_EVENT,
  TEAM_RENAMED_EVENT,
  type EntityLifecycleEvent,
  type EntityLifecycleEventName,
} from "../src/contracts/runtime/entity-lifecycle-events.js";
import { AgentConfigService } from "../src/services/agent/config/index.js";
import { AgentSessionApplication } from "../src/services/sessions/index.js";

class MemoryTeamStore implements IAgentConfigTeamStore {
  async loadTeams() {
    // 内核不再兜底出厂 team：夹具预置一个最小 default team（产品层 ensure 的等价物）。
    return {
      activeTeam: "default",
      teams: new Map<string, AgentConfigTeam>([
        ["default", new Map(Object.entries({
          orchestrator_agent: {
            agent_name: "orchestrator_agent",
            display_name: "Orchestrator Agent",
            description: "入口编排 Agent。",
            enabled: true,
            default_entry: true,
            llm_tiers: null,
            tools: { enabled_tools: [] },
            goals: { enabled: false },
            tasks: { background: false },
            delegation: { enabled_agents: [], parallel_children: false },
            custom_params: {},
          },
        }))],
      ]),
    };
  }
  async saveAll(_activeTeam: string, _teams: Map<string, AgentConfigTeam>) {}
  async saveIndex(_activeTeam: string, _teams: Map<string, AgentConfigTeam>) {}
  async removeTeam(_teamName: string) {}
  async renameTeam(_teamName: string, _newTeamName: string) {}
  async getTeamLocation() { return null; }
}

function lifecycleCapture() {
  const published: Array<{ event: EntityLifecycleEventName; payload: EntityLifecycleEvent }> = [];
  return {
    published,
    binding: {
      tenantId: "tnt_test",
      publish: async (event: EntityLifecycleEventName, payload: EntityLifecycleEvent) => {
        published.push({ event, payload });
      },
    },
  };
}

describe("AgentSessionApplication lifecycle publication", () => {
  function repositoryWith(sessionIds: string[]): AgentSessionRepositoryPort {
    const existing = new Set(sessionIds);
    return {
      getSession: async (sessionId: string) => existing.has(sessionId) ? { session_id: sessionId } as never : null,
      deleteSession: async (sessionId: string) => existing.delete(sessionId),
    } as unknown as AgentSessionRepositoryPort;
  }

  it("publishes session.deleted after a successful delete", async () => {
    const { published, binding } = lifecycleCapture();
    const sessions = new AgentSessionApplication(repositoryWith(["ses_1"]), null, null, null, null, binding);
    await expect(sessions.deleteSession("ses_1")).resolves.toBe(true);
    expect(published).toEqual([{ event: SESSION_DELETED_EVENT, payload: { tenantId: "tnt_test", sessionId: "ses_1" } }]);
  });

  it("does not publish when the session does not exist", async () => {
    const { published, binding } = lifecycleCapture();
    const sessions = new AgentSessionApplication(repositoryWith([]), null, null, null, null, binding);
    await expect(sessions.deleteSession("ses_missing")).resolves.toBe(false);
    expect(published).toEqual([]);
  });

  it("stays silent without a lifecycle binding", async () => {
    const sessions = new AgentSessionApplication(repositoryWith(["ses_1"]));
    await expect(sessions.deleteSession("ses_1")).resolves.toBe(true);
  });
});

describe("AgentConfigService lifecycle publication", () => {
  async function createService() {
    const capture = lifecycleCapture();
    const service = new AgentConfigService(new MemoryTeamStore(), capture.binding);
    await service.initialize();
    return { service, capture };
  }

  it("publishes agent.deleted for deleteAgent with the resolved team", async () => {
    const { service, capture } = await createService();
    await service.createTeam("research");
    await service.createAgent({ agent_name: "writer", display_name: "Writer", default_entry: false }, { teamName: "research" });
    await expect(service.deleteAgent("writer", { teamName: "research" })).resolves.toBe(true);
    expect(capture.published).toEqual([{
      event: AGENT_DELETED_EVENT,
      payload: { tenantId: "tnt_test", teamName: "research", agentName: "writer" },
    }]);
  });

  it("falls back to the active team when deleteAgent omits teamName", async () => {
    const { service, capture } = await createService();
    await service.createAgent({ agent_name: "scribe", display_name: "Scribe", default_entry: false });
    await service.deleteAgent("scribe");
    const event = capture.published.at(-1);
    expect(event?.event).toBe(AGENT_DELETED_EVENT);
    expect((event?.payload as { teamName?: string }).teamName).toBe("default");
  });

  it("publishes team.deleted after the team is removed", async () => {
    const { service, capture } = await createService();
    await service.createTeam("research");
    await service.deleteTeam("research");
    expect(capture.published).toEqual([{
      event: TEAM_DELETED_EVENT,
      payload: { tenantId: "tnt_test", teamName: "research" },
    }]);
  });

  it("publishes team.renamed with previous and next names", async () => {
    const { service, capture } = await createService();
    await service.createTeam("research");
    await service.renameTeam("research", "science");
    expect(capture.published).toEqual([{
      event: TEAM_RENAMED_EVENT,
      payload: { tenantId: "tnt_test", previousTeamName: "research", teamName: "science" },
    }]);
  });

  it("publishes agent.deleted for agents dropped by applyTeamPayload", async () => {
    const { service, capture } = await createService();
    await service.createTeam("research");
    await service.createAgent({ agent_name: "writer", display_name: "Writer", default_entry: false }, { teamName: "research" });
    await service.applyTeamPayload("research", {
      orchestrator_agent: { agent_name: "orchestrator_agent", default_entry: true },
    });
    const deletions = capture.published.filter((item) => item.event === AGENT_DELETED_EVENT);
    expect(deletions.map((item) => (item.payload as { agentName: string }).agentName)).toContain("writer");
  });
});
