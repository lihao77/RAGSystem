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

describe("execution compatibility routes", () => {
  it("reports Python-compatible idle task status for sessions while runtime is not migrated", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/s1/task-status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        session_id: "s1",
        has_running_task: false,
        has_active_system_command: false,
        task_info: null,
        observability: null,
        diagnostics: null,
      },
    });
  });

  it("reports empty execution overview and running task list", async () => {
    app = await buildTestApp();

    const overview = await app.inject({
      method: "GET",
      url: "/api/agent/execution/overview?active_only=false",
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      success: true,
      data: {
        active_only: false,
        count: 0,
        by_execution_kind: {},
        by_status: {},
        sessions: [],
        items: [],
      },
    });

    const running = await app.inject({
      method: "GET",
      url: "/api/agent/tasks/running",
    });
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({
      success: true,
      data: {
        active_only: true,
        count: 0,
        items: [],
      },
    });
  });

  it("returns not-found-shaped task diagnostics for unknown task ids", async () => {
    app = await buildTestApp();

    const status = await app.inject({
      method: "GET",
      url: "/api/agent/tasks/task-1/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      success: true,
      data: {
        task_id: "task-1",
        scope: "task_id",
        scope_id: "task-1",
        found: false,
        has_running_task: false,
        task_info: null,
        observability: null,
      },
    });

    const diagnostics = await app.inject({
      method: "GET",
      url: "/api/agent/tasks/task-1/execution-diagnostics",
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({
      success: true,
      data: {
        task_id: "task-1",
        scope: "task_id",
        scope_id: "task-1",
        found: false,
        diagnostics: null,
      },
    });
  });

  it("keeps synchronous execution routes visible but explicitly not migrated", async () => {
    app = await buildTestApp();

    const execute = await app.inject({
      method: "POST",
      url: "/api/agent/execute",
      payload: {
        task: "hello",
      },
    });
    expect(execute.statusCode).toBe(501);
    expect(execute.json()).toMatchObject({
      success: false,
      code: "not_migrated",
    });

    const executeAgent = await app.inject({
      method: "POST",
      url: "/api/agent/execute/general_agent",
      payload: {
        task: "hello",
      },
    });
    expect(executeAgent.statusCode).toBe(501);
    expect(executeAgent.json()).toMatchObject({
      success: false,
      code: "not_migrated",
    });
  });

  it("validates collaboration mode before the not-migrated boundary like Python", async () => {
    app = await buildTestApp();

    const parallel = await app.inject({
      method: "POST",
      url: "/api/agent/collaborate",
      payload: {
        mode: "parallel",
        tasks: [{ task: "hello" }],
      },
    });
    expect(parallel.statusCode).toBe(400);
    expect(parallel.json()).toMatchObject({
      success: false,
      code: "invalid_request",
      message: "并行模式尚未实现",
    });

    const sequential = await app.inject({
      method: "POST",
      url: "/api/agent/collaborate",
      payload: {
        mode: "sequential",
        tasks: [{ task: "hello" }],
      },
    });
    expect(sequential.statusCode).toBe(501);
    expect(sequential.json()).toMatchObject({
      success: false,
      code: "not_migrated",
    });
  });
});
