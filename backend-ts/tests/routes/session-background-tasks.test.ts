import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createUserId, type RequestIdentity } from "../../src/identity/types.js";
import type { IdentityProvider } from "../../src/services/identity/index.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../src/services/identity/index.js";
import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
  vi.restoreAllMocks();
});

describe("session background task routes", () => {
  it("lists and cancels Session tasks through the management API", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    await harness.container.sessionApplication.createSession({ userId: LOCAL_USER_ID, sessionId: "background-session" });
    const firstId = randomUUID();
    const secondId = randomUUID();
    const publicTask = {
      task_id: firstId,
      description: "background task",
      started_at: 1,
      status: "running" as const,
      return_code: null,
      error: null,
      expires_at: null,
      run_id: null,
      owner_task_id: null,
      completed_at: null,
      result_type: null,
      kind: "bash",
      cancel_supported: true,
      cancel_available: true,
      cancel_unavailable_reason: null,
    };
    const list = vi.spyOn(harness.container.backgroundTasks, "listSessionTasks").mockResolvedValue([publicTask]);
    const cancelOne = vi.spyOn(harness.container.backgroundTasks, "cancelSessionTask").mockResolvedValue({
      task_id: firstId,
      cancelled: true,
      status: "cancelled",
      reason: null,
    });
    const cancelMany = vi.spyOn(harness.container.backgroundTasks, "cancelSessionTasks").mockResolvedValue([
      { task_id: secondId, cancelled: false, status: "running", reason: "not_owned" },
      { task_id: firstId, cancelled: true, status: "cancelled", reason: null },
    ]);

    const listed = await app.inject({ method: "GET", url: "/api/agent/sessions/background-session/background-tasks" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ data: { tasks: [publicTask] } });
    expect(list).toHaveBeenCalledWith("background-session");

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/agent/sessions/background-session/background-tasks/${firstId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ data: { result: { task_id: firstId, cancelled: true } } });
    expect(cancelOne).toHaveBeenCalledWith("background-session", firstId);

    const batch = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/background-session/background-tasks/cancel",
      payload: { task_ids: [secondId, firstId] },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toMatchObject({
      data: { results: [{ task_id: secondId, reason: "not_owned" }, { task_id: firstId, cancelled: true }] },
    });
    expect(cancelMany).toHaveBeenCalledWith("background-session", [secondId, firstId]);
  });

  it("rejects invalid UUIDs, empty batches, and duplicate task IDs with 422", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    await harness.container.sessionApplication.createSession({ userId: LOCAL_USER_ID, sessionId: "validation-session" });
    const taskId = randomUUID();
    const cancelOne = vi.spyOn(harness.container.backgroundTasks, "cancelSessionTask");
    const cancelMany = vi.spyOn(harness.container.backgroundTasks, "cancelSessionTasks");

    const invalidId = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/validation-session/background-tasks/not-a-uuid/cancel",
    });
    const empty = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/validation-session/background-tasks/cancel",
      payload: { task_ids: [] },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/validation-session/background-tasks/cancel",
      payload: { task_ids: [taskId, taskId] },
    });
    const invalidBatchId = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/validation-session/background-tasks/cancel",
      payload: { task_ids: ["not-a-uuid"] },
    });

    for (const response of [invalidId, empty, duplicate, invalidBatchId]) {
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ success: false, code: "validation_error" });
    }
    expect(cancelOne).not.toHaveBeenCalled();
    expect(cancelMany).not.toHaveBeenCalled();
  });

  it("checks Session ownership before listing or cancelling tasks", async () => {
    const owner = createUserId("usr_background_owner");
    const other = createUserId("usr_background_other");
    const identityProvider: IdentityProvider = {
      async resolve(request: FastifyRequest): Promise<RequestIdentity> {
        return {
          userId: request.headers["x-test-user"] === "other" ? other : owner,
          tenantId: LOCAL_TENANT_ID,
          role: "member",
          permissions: [],
        };
      },
    };
    const harness = await buildTestHarness({ identityProvider });
    app = harness.app;
    harness.controlStore.createTenant({ id: LOCAL_TENANT_ID, displayName: "Local" });
    await harness.container.sessionApplication.createSession({ userId: owner, sessionId: "private-background-session" });
    const list = vi.spyOn(harness.container.backgroundTasks, "listSessionTasks");
    const cancel = vi.spyOn(harness.container.backgroundTasks, "cancelSessionTask");
    const taskId = randomUUID();

    const listed = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/private-background-session/background-tasks",
      headers: { "x-test-user": "other" },
    });
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/agent/sessions/private-background-session/background-tasks/${taskId}/cancel`,
      headers: { "x-test-user": "other" },
    });

    expect(listed.statusCode).toBe(403);
    expect(cancelled.statusCode).toBe(403);
    expect(list).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
