import { afterEach, describe, expect, it } from "vitest";
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
    harness.container.conversationStore.createSession(LOCAL_TENANT_ID, "approval-route-session");

    const approvalPromise = harness.container.pendingInteractions.waitForApproval({
      sessionId: "approval-route-session",
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
});
