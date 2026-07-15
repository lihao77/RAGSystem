import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestHarness } from "../helpers/app.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("interaction response routes", () => {
  it("resolves pending approvals through the generic HTTP route", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    harness.container.conversationStore.createSession(LOCAL_TENANT_ID, "approval-route-session", "usr_local");

    const approvalPromise = harness.container.pendingInteractions.waitForApproval({
      sessionId: "approval-route-session",
      runId: "approval-route-run",
      rootRunId: "approval-route-run",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "approval-route-tool-call",
      deadlineMs: 120_000,
      task: "执行命令",
      toolName: "execute_bash",
      arguments: { command: "echo ok" },
      riskLevel: "high",
      description: "Execute bash command",
    });
    const approvalRequired = harness.container.realtimeEvents
      .getHistory("approval-route-session")
      .find((event) => event.type === "interaction");
    const approvalId = approvalRequired?.call_id;

    const responded = await app.inject({
      method: "POST",
      url: `/api/agent/sessions/approval-route-session/interactions/${approvalId}/respond`,
      payload: {
        kind: "approval",
        approved: true,
        message: "允许执行",
      },
    });

    expect(responded.statusCode).toBe(200);
    expect(responded.json()).toMatchObject({
      success: true,
      data: {
        resolved: true,
        interaction_id: approvalId,
        approval_id: approvalId,
        kind: "approval",
        approved: true,
        message: "允许执行",
      },
    });
    await expect(approvalPromise).resolves.toMatchObject({
      approvalId,
      approved: true,
      message: "允许执行",
    });
    expect(
      harness.container.conversationStore
        .listOutboxForReplay({ sessionId: "approval-route-session" })
        .map((row) => row.event_type),
    ).toEqual(["client.interaction", "client.interaction"]);
  });

  it("挂起后的响应立即返回 resuming 并触发恢复执行器", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    harness.container.conversationStore.createSession(LOCAL_TENANT_ID, "resume-route-session", "usr_local");
    const resumeRun = vi.spyOn(harness.container.resumeExecutor, "resumeRun").mockReturnValue({
      rootRunId: "resume-route-run",
      approvalId: "approval-id",
      toolCallId: "resume-tool-call",
    });

    const suspended = harness.container.pendingInteractions.waitForApproval({
      sessionId: "resume-route-session",
      runId: "resume-route-run",
      rootRunId: "resume-route-run",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "resume-tool-call",
      deadlineMs: 0,
      task: "恢复任务",
      toolName: "execute_bash",
    });
    const approvalId = harness.container.realtimeEvents.getHistory("resume-route-session")[0]?.call_id ?? "";
    await expect(suspended).rejects.toBeDefined();

    const responded = await app.inject({
      method: "POST",
      url: `/api/agent/sessions/resume-route-session/approvals/${approvalId}/respond`,
      payload: { approved: true, message: "继续" },
    });

    expect(responded.statusCode).toBe(200);
    expect(responded.json()).toMatchObject({ success: true, data: { resolved: true, resuming: true } });
    expect(resumeRun).toHaveBeenCalledWith({
      sessionId: "resume-route-session",
      approvalId,
      resolution: { approved: true, message: "继续" },
    });
  });
});
