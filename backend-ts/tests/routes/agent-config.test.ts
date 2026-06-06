import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("agent config compatibility routes", () => {
  it("serves default team and default agent configs for chat bootstrap", async () => {
    app = await buildTestApp();

    const teams = await app.inject({
      method: "GET",
      url: "/api/agent-config/teams",
    });
    expect(teams.statusCode).toBe(200);
    expect(teams.json()).toMatchObject({
      success: true,
      data: {
        active_team: "default",
        teams: [
          {
            team_name: "default",
            is_active: true,
            agent_count: 7,
          },
        ],
      },
    });
    expect(teams.json().data.teams[0].agents).toContain("orchestrator_agent");

    const configs = await app.inject({
      method: "GET",
      url: "/api/agent-config/configs",
    });
    expect(configs.statusCode).toBe(200);
    expect(configs.json()).toMatchObject({
      success: true,
      data: {
        orchestrator_agent: {
          agent_name: "orchestrator_agent",
          enabled: true,
          default_entry: true,
          delegation: {
            enabled_agents: expect.arrayContaining(["general_agent"]),
          },
        },
      },
    });
  });

  it("supports in-memory team create, activate, copy, and delete", async () => {
    app = await buildTestApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/agent-config/teams",
      payload: {
        team_name: "research",
        source_team: "default",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.teams.map((team: { team_name: string }) => team.team_name)).toContain("research");

    const activated = await app.inject({
      method: "POST",
      url: "/api/agent-config/teams/research/activate",
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({
      data: {
        active_team: "research",
      },
    });

    const scratch = await app.inject({
      method: "POST",
      url: "/api/agent-config/teams",
      payload: {
        team_name: "scratch",
      },
    });
    expect(scratch.statusCode).toBe(200);

    const copied = await app.inject({
      method: "POST",
      url: "/api/agent-config/teams/scratch/copy-agents",
      payload: {
        source_team: "default",
        agent_names: ["general_agent"],
      },
    });
    expect(copied.statusCode).toBe(200);
    const scratchTeam = copied.json().data.teams.find((team: { team_name: string }) => team.team_name === "scratch");
    expect(scratchTeam).toMatchObject({
      agent_count: 1,
      agents: ["general_agent"],
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/agent-config/teams/scratch",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.teams.map((team: { team_name: string }) => team.team_name)).not.toContain("scratch");
  });

  it("updates configs and keeps a single default entry in the active team", async () => {
    app = await buildTestApp();

    const current = await app.inject({
      method: "GET",
      url: "/api/agent-config/configs/general_agent",
    });
    const payload = current.json().data;
    payload.default_entry = true;

    const updated = await app.inject({
      method: "PUT",
      url: "/api/agent-config/configs/general_agent",
      payload,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      data: {
        agent_name: "general_agent",
        default_entry: true,
      },
    });

    const configs = await app.inject({
      method: "GET",
      url: "/api/agent-config/configs",
    });
    expect(configs.json().data.general_agent.default_entry).toBe(true);
    expect(configs.json().data.orchestrator_agent.default_entry).toBe(false);
  });

  it("returns static supplementary metadata and exports configs", async () => {
    app = await buildTestApp();

    const memory = await app.inject({
      method: "GET",
      url: "/api/agent-config/memory-metadata",
    });
    expect(memory.statusCode).toBe(200);
    expect(memory.json().data.scopes.map((scope: { name: string }) => scope.name)).toEqual([
      "team",
      "session",
      "agent",
      "workspace",
    ]);

    const tools = await app.inject({
      method: "GET",
      url: "/api/agent-config/tools",
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().data.map((tool: { name: string }) => tool.name)).toContain("read_file");
    expect(tools.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "read_file",
          runtime_status: "implemented",
          implemented: true,
        }),
        expect.objectContaining({
          name: "write_file",
          runtime_status: "implemented",
          implemented: true,
          risk_level: "high",
        }),
        expect.objectContaining({
          name: "execute_bash",
          runtime_status: "not_migrated",
          implemented: false,
        }),
      ]),
    );

    const exportedJson = await app.inject({
      method: "GET",
      url: "/api/agent-config/configs/general_agent/export?format=json",
    });
    expect(exportedJson.statusCode).toBe(200);
    expect(exportedJson.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(exportedJson.body)).toMatchObject({
      agent_name: "general_agent",
      llm_tiers: {
        default: {
          model_name: "deepseek-chat",
        },
      },
    });

    const exportedYaml = await app.inject({
      method: "GET",
      url: "/api/agent-config/configs/general_agent/export",
    });
    expect(exportedYaml.statusCode).toBe(200);
    expect(exportedYaml.headers["content-type"]).toContain("application/x-yaml");
    expect(exportedYaml.body).toContain('agent_name: "general_agent"');
  });

  it("applies built-in presets in memory and keeps import as an explicit boundary", async () => {
    app = await buildTestApp();

    const preset = await app.inject({
      method: "POST",
      url: "/api/agent-config/configs/general_agent/preset",
      payload: {
        preset: "fast",
      },
    });
    expect(preset.statusCode).toBe(200);
    expect(preset.json()).toMatchObject({
      success: true,
      data: {
        agent_name: "general_agent",
        llm_tiers: {
          default: {
            temperature: 0.1,
            max_completion_tokens: 2048,
          },
        },
      },
    });

    const invalidPreset = await app.inject({
      method: "POST",
      url: "/api/agent-config/configs/general_agent/preset",
      payload: {
        preset: "missing",
      },
    });
    expect(invalidPreset.statusCode).toBe(400);
    expect(invalidPreset.json()).toMatchObject({
      success: false,
      code: "invalid_request",
    });

    const imported = await app.inject({
      method: "POST",
      url: "/api/agent-config/configs/general_agent/import",
      payload: {},
    });
    expect(imported.statusCode).toBe(501);
    expect(imported.json()).toMatchObject({
      success: false,
      code: "not_migrated",
    });
  });
});
