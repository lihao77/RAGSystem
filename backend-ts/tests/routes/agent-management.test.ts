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

describe("agent management compatibility routes", () => {
  it("lists active team agents in the Python registry shape", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/agents",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      success: true,
      message: "共有 7 个智能体",
    });
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "orchestrator_agent",
          agent_name: "orchestrator_agent",
          default_entry: true,
          config: expect.objectContaining({
            enabled: true,
            custom_params: expect.objectContaining({
              type: "orchestrator",
            }),
          }),
        }),
      ]),
    );
  });

  it("creates and deletes an in-memory agent config", async () => {
    app = await buildTestApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/agent/agents/create",
      payload: {
        agent_name: "smoke_agent",
        display_name: "Smoke Agent",
        description: "Smoke-test agent",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      success: true,
      data: {
        agent_name: "smoke_agent",
        display_name: "Smoke Agent",
        description: "Smoke-test agent",
        default_entry: false,
        custom_params: {
          type: "orchestrator",
        },
      },
    });

    const configs = await app.inject({
      method: "GET",
      url: "/api/agent-config/configs",
    });
    expect(configs.json().data.smoke_agent).toMatchObject({
      agent_name: "smoke_agent",
      display_name: "Smoke Agent",
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/agent/agents",
    });
    expect(listed.json().data.map((agent: { name: string }) => agent.name)).toContain("smoke_agent");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/agent/agents/delete/smoke_agent",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      success: true,
      message: "智能体 smoke_agent 已删除",
    });

    const afterDelete = await app.inject({
      method: "GET",
      url: "/api/agent-config/configs",
    });
    expect(afterDelete.json().data.smoke_agent).toBeUndefined();
  });

  it("rejects duplicate creates and protects the default entry agent", async () => {
    app = await buildTestApp();

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/agent/agents/create",
      payload: {
        agent_name: "general_agent",
      },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({
      success: false,
      code: "invalid_request",
    });

    const protectedDelete = await app.inject({
      method: "DELETE",
      url: "/api/agent/agents/delete/orchestrator_agent",
    });
    expect(protectedDelete.statusCode).toBe(403);
    expect(protectedDelete.json()).toMatchObject({
      success: false,
      code: "forbidden",
      message: "系统核心智能体禁止删除",
    });

    const missingDelete = await app.inject({
      method: "DELETE",
      url: "/api/agent/agents/delete/missing_agent",
    });
    expect(missingDelete.statusCode).toBe(404);
    expect(missingDelete.json()).toMatchObject({
      success: false,
      code: "not_found",
    });
  });

  it("reloads TS agent configuration as a compatibility endpoint", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/agents/reload",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      message: "智能体已重新加载",
      data: {
        runtime: "ts",
        reloaded: true,
      },
    });
  });
});
