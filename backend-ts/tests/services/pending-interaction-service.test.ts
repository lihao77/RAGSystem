import { describe, expect, it } from "vitest";

import { InMemoryEventBus } from "../../src/services/runtime/event-bus.js";
import { PendingInteractionService } from "../../src/services/runtime/pending-interaction-service.js";

describe("PendingInteractionService", () => {
  it("resolves approval interactions through the generic interaction response path", async () => {
    const events = new InMemoryEventBus();
    const service = new PendingInteractionService(events);

    const approvalPromise = service.waitForApproval({
      sessionId: "s1",
      runId: "run-1",
      taskId: "task-1",
      requestId: "req-1",
      toolCallId: "tool-call-1",
      toolName: "execute_bash",
      arguments: { command: "echo ok" },
      riskLevel: "high",
      description: "Execute bash command",
      permissionMode: "standard",
      approvalReason: "标准模式：high 风险工具需要审批",
      approvalReasonCodes: ["ask-risk"],
    });

    const history = events.getHistory("s1");
    const interactionRequired = history.find((event) => event.type === "interaction.required");
    const approvalRequired = history.find((event) => event.type === "user.approval_required");
    expect(interactionRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "approval",
      approval_id: expect.any(String),
      tool_call_id: "tool-call-1",
      tool_name: "execute_bash",
      arguments: { command: "echo ok" },
      risk_level: "high",
      description: "Execute bash command",
      permission_mode: "standard",
      approval_reason: "标准模式：high 风险工具需要审批",
      approval_reason_codes: ["ask-risk"],
      run_id: "run-1",
      task_id: "task-1",
      request_id: "req-1",
    });
    expect(approvalRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "approval",
      approval_id: expect.any(String),
    });

    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;
    expect(service.isApprovalPending("s1", approvalId)).toBe(true);
    expect(
      service.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: true,
        message: "允许执行",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
      interactionId: approvalId,
      approved: true,
      message: "允许执行",
    });

    await expect(approvalPromise).resolves.toMatchObject({
      approvalId,
      approved: true,
      message: "允许执行",
    });
    expect(service.isApprovalPending("s1", approvalId)).toBe(false);
  });
});
