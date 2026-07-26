import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestHarness } from "../helpers/app.js";
import { getRealtimeHistory } from "../helpers/realtime.js";
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
    harness.localInfrastructure.conversationStore.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "approval-route-session", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    harness.localInfrastructure.conversationStore.createRun({ runId: "approval-route-run", sessionId: "approval-route-session", agentName: "orchestrator_agent" });

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
    await vi.waitFor(() => expect(getRealtimeHistory(harness.container.realtimeEvents, "approval-route-session")
      .find((event) => event.type === "interaction")).toBeDefined());
    const approvalRequired = getRealtimeHistory(harness.container.realtimeEvents, "approval-route-session")
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
      harness.localInfrastructure.conversationStore
        .listOutboxForReplay({ sessionId: "approval-route-session" })
        .map((row) => row.event_type),
    ).toEqual(["client.interaction", "client.interaction"]);
  });

  it("挂起后的响应立即返回 resuming 并触发恢复执行器", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    harness.localInfrastructure.conversationStore.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "resume-route-session", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    harness.localInfrastructure.conversationStore.createRun({ runId: "resume-route-run", sessionId: "resume-route-session", agentName: "orchestrator_agent" });

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
    await expect(suspended).rejects.toBeDefined();
    harness.localInfrastructure.conversationStore.updateRunStatus("resume-route-run", "resume-route-session", "suspended", null);
    harness.container.interactionCoordinator.bindResumeStarter({
      startClaim: vi.fn().mockReturnValue({ promise: Promise.resolve({ content: "resumed", success: true }) }),
    });
    await vi.waitFor(() => expect(getRealtimeHistory(harness.container.realtimeEvents, "resume-route-session")[0]).toBeDefined());
    const approvalId = getRealtimeHistory(harness.container.realtimeEvents, "resume-route-session")[0]?.call_id ?? "";

    const responded = await app.inject({
      method: "POST",
      url: `/api/agent/sessions/resume-route-session/approvals/${approvalId}/respond`,
      payload: { approved: true, message: "继续" },
    });

    expect(responded.statusCode).toBe(200);
    expect(responded.json()).toMatchObject({ success: true, data: { resolved: true, resuming: true } });
  });
});
