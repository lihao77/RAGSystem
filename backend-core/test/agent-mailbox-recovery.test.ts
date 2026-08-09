import { describe, expect, it, vi } from "vitest";

import { createLaunchers } from "../src/services/agent/execution/launchers.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

describe("Agent mailbox continuation result recovery", () => {
  it("rebuilds one missing terminal result from the durable continuation Run", async () => {
    const worker = { agent_name: "worker", display_name: "Worker", enabled: true };
    const parent = { agent_name: "parent", display_name: "Parent", enabled: true };
    const session = {
      session_id: "session-1",
      tenant_id: "tenant-1",
      owner_user_id: null,
      visibility: "private",
      origin_type: "direct",
      origin_id: null,
      origin_channel: "api",
      workspace_id: null,
      team_snapshot: createTestTeamSnapshot("parent", [parent, worker] as never),
      permission_mode: null,
      metadata: {},
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    const continuationRun = {
      run_id: "continuation-run",
      session_id: "session-1",
      tenant_id: "tenant-1",
      entrypoint: "system.agent_message",
      status: "completed",
      task_summary: null,
      terminal_reason: null,
      request_id: "agent_result:source-request",
      user_id: null,
      agent_name: "worker",
      agent_call_id: "continuation-call",
      lineage_parent_call_id: "parent-call",
      agent_display_name: "Worker",
      lease_root_run_id: "continuation-run",
      thread_key: "child:child-1",
      parent_run_id: "parent-run",
      parent_call_id: "parent-tool-call",
      child_agent_id: "child-1",
      final_message_id: "continuation-final",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    const parentRun = {
      ...continuationRun,
      run_id: "parent-run",
      entrypoint: "agent_stream",
      agent_name: "parent",
      agent_call_id: "parent-call",
      agent_display_name: "Parent",
      lease_root_run_id: "parent-run",
      thread_key: "root",
      parent_run_id: null,
      parent_call_id: null,
      child_agent_id: null,
      final_message_id: "parent-final",
    };
    const stored = new Map<string, any>([["source-request", {
      message_id: "source-request",
      status: "acked",
      correlation_id: "corr-1",
    }]]);
    const enqueue = vi.fn(async (input: Record<string, any>) => {
      const message = {
        message_id: input.messageId,
        status: "queued",
        correlation_id: input.correlationId,
      };
      stored.set(message.message_id, message);
      return message;
    });
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: { getSession: vi.fn(async () => session) } as never,
      runtimeCore: {} as never,
      slashCommandHandler: {} as never,
      attachmentResolver: {} as never,
      statusTracker: { getStatusBySession: vi.fn(() => ({ status: "running" })) } as never,
      eventPublisher: {} as never,
      runEngine: {} as never,
      invocationService: {} as never,
      notificationQueue: {} as never,
      backgroundTasks: null,
      goalStore: null,
      runtimeStorage: { operations: {} } as never,
      clientEvents: {} as never,
      mailbox: {
        get: vi.fn(async (_sessionId: string, messageId: string) => stored.get(messageId) ?? null),
        enqueue,
      } as never,
      runReader: {
        listRuns: vi.fn(async () => ({ items: [continuationRun], total: 1 })),
        getRun: vi.fn(async (_sessionId: string, runId: string) => runId === "parent-run" ? parentRun : null),
        getMessageById: vi.fn(async () => ({
          content: "recovered result",
          content_parts: [{ type: "text", text: "recovered result" }],
        })),
      } as never,
      participantRuns: { registerParticipantRun: vi.fn(), releaseParticipantRun: vi.fn() },
    });

    launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => enqueue.mock.calls.length === 1);
    launchers.triggerBgNotificationRun("session-1");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "continuation-run:terminal_result",
      targetRunId: "parent-run",
      replyToMessageId: "source-request",
      correlationId: "corr-1",
      contentParts: [{ type: "text", text: "recovered result" }],
    }));
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}
