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

describe("foundation routes", () => {
  it("reports backend-ts health and migration status", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        status: "healthy",
        backend: "backend-ts",
        migration_status: "foundation",
      },
    });
  });

  it("creates and lists sessions through Python-compatible route shapes", async () => {
    app = await buildTestApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/agent/sessions",
      payload: {
        session_id: "session-test",
        user_id: "user-test",
        metadata: { team: "default" },
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      success: true,
      data: {
        session_id: "session-test",
        user_id: "user-test",
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/agent/sessions?user_id=user-test",
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      success: true,
      data: {
        total: 1,
        items: [
          {
            session_id: "session-test",
            user_id: "user-test",
          },
        ],
      },
    });
  });

  it("keeps agent stream route visible but explicitly not migrated", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: {
        task: "hello",
        session_id: "s1",
      },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      success: false,
      code: "not_migrated",
    });
  });

  it("rejects empty stream requests before the not-migrated boundary", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: {
        task: "",
        attachments: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      code: "invalid_request",
    });
  });

  it("preserves request validation errors instead of reporting internal errors", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-config/configs/general_agent/preset",
      headers: {
        "content-type": "text/plain",
      },
      payload: "preset=fast",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      code: "invalid_request",
    });
  });

  it("does not report stream stop success without an active execution", async () => {
    app = await buildTestApp();

    await app.inject({
      method: "POST",
      url: "/api/agent/sessions",
      payload: {
        session_id: "idle-session",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/stream/stop",
      payload: {
        session_id: "idle-session",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      success: false,
      code: "not_found",
      message: "该会话没有正在执行的任务",
    });
  });
});
