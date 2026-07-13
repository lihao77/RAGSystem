import { describe, expect, it } from "vitest";

import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import { PendingInteractionService } from "../../src/services/runtime/pending-interaction-service.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

describe("PendingInteractionService", () => {
  it("resolves approval interactions through the generic interaction response path", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const clientEvents = new DurableClientEventPublisher(store, dispatcher);
    const service = new PendingInteractionService(clientEvents);
    store.createSession(LOCAL_TENANT_ID, "s1");

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

    const history = realtimeEvents.getHistory("s1");
    const approvalRequired = history.find(
      (event) =>
        event.type === "interaction" &&
        (event.payload as { kind?: string; phase?: string }).kind === "approval" &&
        (event.payload as { phase?: string }).phase === "required",
    );
    // 新协议：interaction.required + user.approval_required 合并为单条 interaction(approval, required)。
    expect(history.map((event) => event.seq)).toEqual([1]);
    expect(
      store.listOutboxForReplay({ sessionId: "s1" }).map((row) => ({
        eventType: row.event_type,
        status: row.status,
        sessionSeq: row.session_seq,
      })),
    ).toEqual([
      { eventType: "client.interaction", status: "delivered", sessionSeq: 1 },
    ]);
    expect(approvalRequired).toMatchObject({
      call_id: expect.any(String),
      run_id: "run-1",
      payload: {
        kind: "approval",
        phase: "required",
        tool: "execute_bash",
        risk_level: "high",
        prompt: "Execute bash command",
        input: {
          approval_id: expect.any(String),
          approval_type: null,
          tool_call_id: "tool-call-1",
          agent_name: null,
          arguments: { command: "echo ok" },
          permission_mode: "standard",
          approval_reason: "标准模式：high 风险工具需要审批",
          approval_reason_codes: ["ask-risk"],
          approval_secondary_reasons: [],
          approval_hook: {},
          external_path_candidates: [],
        },
        message: "标准模式：high 风险工具需要审批",
      },
    });

    const approvalId = approvalRequired?.call_id as string;
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
    const resolvedHistory = realtimeEvents.getHistory("s1");
    const approvalResolved = resolvedHistory.find(
      (event) =>
        event.type === "interaction" &&
        (event.payload as { kind?: string; phase?: string }).kind === "approval" &&
        (event.payload as { phase?: string }).phase === "responded",
    );
    expect(resolvedHistory.map((event) => event.seq)).toEqual([1, 2]);
    expect(approvalResolved).toMatchObject({
      seq: 2,
      run_id: "run-1",
      call_id: approvalId,
      payload: {
        kind: "approval",
        phase: "responded",
        approved: true,
        message: "允许执行",
      },
    });
    expect(
      store.listOutboxForReplay({ sessionId: "s1" }).map((row) => ({
        eventType: row.event_type,
        status: row.status,
        sessionSeq: row.session_seq,
      })),
    ).toEqual([
      { eventType: "client.interaction", status: "delivered", sessionSeq: 1 },
      { eventType: "client.interaction", status: "delivered", sessionSeq: 2 },
    ]);
    store.close();
  });
});
