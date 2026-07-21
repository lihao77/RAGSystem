import { describe, expect, it } from "vitest";

import {
  PostgresAgentConfigTeamStore,
  syntheticTeamLocation,
} from "../../../../src/adapters/saas/postgres/agent-team-repository.js";
import type { PostgresMemoryExecutor } from "../../../../src/adapters/saas/postgres/memory-repository.js";
import type { AgentConfig } from "../../../../src/contracts/agent/agent-config.js";
import { createTenantId } from "../../../../src/identity/types.js";

type Row = Record<string, unknown>;

function createMemoryExecutor(): PostgresMemoryExecutor & {
  teams: Map<string, Row>;
  index: Map<string, string>;
} {
  const teams = new Map<string, Row>();
  const index = new Map<string, string>();
  const keyOf = (tenantId: string, teamName: string) => `${tenantId}::${teamName}`;

  const executor = {
    teams,
    index,
    async query(sql: string, params: readonly unknown[] = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      const tenantId = String(params[0] ?? "");

      if (text.startsWith("SELECT team_name, document, location FROM agent_teams")) {
        const rows = Array.from(teams.entries())
          .filter(([key]) => key.startsWith(`${tenantId}::`))
          .map(([, row]) => row)
          .sort((a, b) => String(a.team_name).localeCompare(String(b.team_name)));
        return { rows, rowCount: rows.length };
      }

      if (text.startsWith("SELECT active_team FROM agent_team_index")) {
        const active = index.get(tenantId);
        return active ? { rows: [{ active_team: active }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      if (text.startsWith("INSERT INTO agent_team_index")) {
        index.set(tenantId, String(params[1]));
        return { rows: [], rowCount: 1 };
      }

      if (text.startsWith("DELETE FROM agent_teams WHERE tenant_id=$1 AND NOT")) {
        const keep = new Set((params[1] as string[] | undefined) ?? []);
        for (const key of Array.from(teams.keys())) {
          if (!key.startsWith(`${tenantId}::`)) continue;
          const teamName = key.slice(tenantId.length + 2);
          if (!keep.has(teamName)) teams.delete(key);
        }
        return { rows: [], rowCount: 1 };
      }

      if (text.startsWith("DELETE FROM agent_teams WHERE tenant_id=$1 AND team_name=$2")) {
        teams.delete(keyOf(tenantId, String(params[1])));
        return { rows: [], rowCount: 1 };
      }

      if (text.startsWith("DELETE FROM agent_teams WHERE tenant_id=$1")) {
        for (const key of Array.from(teams.keys())) {
          if (key.startsWith(`${tenantId}::`)) teams.delete(key);
        }
        return { rows: [], rowCount: 1 };
      }

      if (text.startsWith("SELECT document, location FROM agent_teams")) {
        const row = teams.get(keyOf(tenantId, String(params[1])));
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      if (text.startsWith("INSERT INTO agent_teams")) {
        const teamName = String(params[1]);
        const document = typeof params[2] === "string" ? JSON.parse(String(params[2])) : params[2];
        const location = params[3] == null ? null : String(params[3]);
        teams.set(keyOf(tenantId, teamName), {
          tenant_id: tenantId,
          team_name: teamName,
          document,
          location,
        });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`unexpected sql: ${text}`);
    },
    async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> {
      return fn(executor);
    },
  };

  return executor;
}

function minimalAgent(name: string, isDefault = false): AgentConfig {
  return {
    agent_name: name,
    display_name: name,
    description: null,
    enabled: true,
    default_entry: isDefault,
    llm_tiers: {
      default: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        temperature: 0.2,
        max_completion_tokens: 1024,
        max_context_tokens: 8192,
        extra_params: {},
      },
    },
    tools: { enabled_tools: ["read_file"] },
    skills: { enabled_skills: [] },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: ["team", "session", "user"],
      write_scopes: ["session", "user"],
      archive_scopes: ["session", "user"],
    },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: {},
  };
}

describe("PostgresAgentConfigTeamStore", () => {
  it("scopes load/save by tenant and returns synthetic locations", async () => {
    const tenant = createTenantId("tnt_agent_teams");
    const executor = createMemoryExecutor();
    const store = new PostgresAgentConfigTeamStore(tenant, executor);

    expect(await store.loadTeams()).toBeNull();

    const teams = new Map([
      ["default", new Map([["orchestrator_agent", minimalAgent("orchestrator_agent", true)]])],
      ["research", new Map([["researcher", minimalAgent("researcher")]])],
    ]);
    await store.saveAll("research", teams);

    const loaded = await store.loadTeams();
    expect(loaded?.activeTeam).toBe("research");
    expect(Array.from(loaded?.teams.keys() ?? []).sort()).toEqual(["default", "research"]);
    expect(loaded?.teams.get("default")?.get("orchestrator_agent")?.agent_name).toBe("orchestrator_agent");
    expect(await store.getTeamLocation("default")).toBe(syntheticTeamLocation("default"));
    expect(executor.index.get(tenant)).toBe("research");
    expect(executor.teams.size).toBe(2);
  });

  it("renames and removes teams without dual-write", async () => {
    const tenant = createTenantId("tnt_agent_teams_mut");
    const executor = createMemoryExecutor();
    const store = new PostgresAgentConfigTeamStore(tenant, executor);
    const teams = new Map([
      ["alpha", new Map([["a1", minimalAgent("a1", true)]])],
      ["beta", new Map([["b1", minimalAgent("b1")]])],
    ]);
    await store.saveAll("alpha", teams);

    await store.renameTeam("alpha", "gamma");
    await store.removeTeam("beta");
    await store.saveIndex("gamma", new Map([["gamma", teams.get("alpha")!]]));

    const loaded = await store.loadTeams();
    expect(Array.from(loaded?.teams.keys() ?? [])).toEqual(["gamma"]);
    expect(loaded?.activeTeam).toBe("gamma");
    expect(loaded?.teams.get("gamma")?.has("a1")).toBe(true);
    expect(executor.teams.has(`${tenant}::beta`)).toBe(false);
  });
});
