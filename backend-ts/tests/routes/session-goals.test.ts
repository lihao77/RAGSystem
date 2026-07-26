import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
  vi.restoreAllMocks();
});

describe("session Goal routes", () => {
  it("reads history and pauses/resumes the current Goal", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    await harness.container.sessionApplication.createSession({ sessionId: "goal-session", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    const goal = await harness.container.goalStore.create("goal-session", {
      objective: "Deliver Goal mode",
      successCriteria: ["all tests pass"],
      steps: [{ id: "1", title: "Implement", description: "Build backend", status: "in_progress", evidence: null }],
    });
    const schedule = vi.spyOn(harness.container.backgroundTasks, "scheduleAutoTrigger").mockImplementation(() => undefined);
    const stop = vi.spyOn(harness.container.agentExecution, "stopSession").mockResolvedValue(false);

    const current = await app.inject({ method: "GET", url: "/api/agent/sessions/goal-session/goals/current" });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ success: true, data: { goal: { id: goal.id, status: "active" } } });

    const paused = await app.inject({ method: "POST", url: "/api/agent/sessions/goal-session/goals/current/pause" });
    expect(paused.json()).toMatchObject({ data: { goal: { id: goal.id, status: "paused" } } });
    expect(stop).toHaveBeenCalledWith("goal-session");

    const started = await app.inject({ method: "POST", url: "/api/agent/sessions/goal-session/goals/current/start" });
    expect(started.json()).toMatchObject({ data: { goal: { id: goal.id, status: "active" } } });
    expect(schedule).toHaveBeenCalledWith("goal-session");

    const listed = await app.inject({ method: "GET", url: "/api/agent/sessions/goal-session/goals" });
    expect(listed.json()).toMatchObject({ data: { goals: [{ id: goal.id }] } });
  });

  it("returns null for no current Goal and 404 for start/pause", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    await harness.container.sessionApplication.createSession({ sessionId: "empty-goal-session", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });

    const current = await app.inject({ method: "GET", url: "/api/agent/sessions/empty-goal-session/goals/current" });
    expect(current.json()).toMatchObject({ success: true, data: { goal: null } });
    expect((await app.inject({ method: "POST", url: "/api/agent/sessions/empty-goal-session/goals/current/start" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/agent/sessions/empty-goal-session/goals/current/pause" })).statusCode).toBe(404);
  });
});
