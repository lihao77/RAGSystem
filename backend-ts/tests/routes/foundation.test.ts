import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp, buildTestHarness } from "../helpers/app.js";
import { SaaSSessionApplication } from "../../src/adapters/saas/application/session/saas-session-application.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("foundation routes", () => {
  it("serves unauthenticated liveness and readiness probes without acquiring a tenant runtime", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const acquire = vi.spyOn(harness.registry, "acquire");

    const live = await app.inject({ method: "GET", url: "/livez" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "alive" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: "ready",
      service: "ragsystem-backend",
      checks: {
        control_database: "ok",
        migrations: "ok",
        control_schema_version: expect.any(Number),
      },
    });
    expect(acquire).not.toHaveBeenCalled();
  });

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
        migration_status: "runtime_migrated",
        agents_count: expect.any(Number),
      },
    });
  });

  it("does not expose the retired agent-specific health endpoint", async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/api/agent/health" });
    expect(response.statusCode).toBe(404);
  });

  it("creates and lists sessions through Python-compatible route shapes", async () => {
    app = await buildTestApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/agent/sessions",
      payload: {
        session_id: "session-test",
        metadata: { team: "default" },
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      success: true,
      data: {
        session_id: "session-test",
        owner_user_id: "usr_local",
        visibility: "private",
        origin: { type: "direct", id: null, channel: "web" },
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/agent/sessions",
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      success: true,
      data: {
        items: [
          {
            session_id: "session-test",
            origin: { type: "direct", id: null, channel: "web" },
          },
        ],
        next_cursor: null,
      },
    });
  });

  it("keeps agent stream route visible and reports runtime-core configuration gaps", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: {
        task: "hello",
        session_id: "s1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      code: "invalid_request",
    });
  });

  it("validates stream session ownership against the SaaS conversation repository", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        session_id: "other-tenant-session",
        tenant_id: "tenant-other",
        user_id: "user-other",
        permission_mode: null,
        metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    };
    const saas = new SaaSSessionApplication(LOCAL_TENANT_ID, repository as never);
    const harness = await buildTestHarness({ resolveSessionApplication: () => saas });
    app = harness.app;
    const startStream = vi.spyOn(harness.container.agentExecution, "startStream");

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: { task: "hello", session_id: "other-tenant-session" },
    });

    expect(response.statusCode).toBe(404);
    expect(repository.getSession).toHaveBeenCalledWith("other-tenant-session");
    expect(startStream).not.toHaveBeenCalled();
  });

  it("rejects empty stream requests before starting runtime execution", async () => {
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
