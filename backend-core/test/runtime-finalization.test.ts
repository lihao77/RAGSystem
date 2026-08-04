import { describe, expect, it, vi } from "vitest";

import { buildTerminalToolMessages } from "../src/contracts/storage/runtime-finalization.js";
import type { RuntimeFinalizeRunInput, RuntimeStorage } from "../src/contracts/storage/runtime-storage.js";
import type { MessageInfo } from "../src/contracts/session/session.js";
import { createTenantId } from "../src/identity/types.js";
import { AsyncKernelEventPersister } from "../src/services/agent/sdk/async-event-persister.js";

describe("buildTerminalToolMessages", () => {
  it.each([
    {
      terminalStatus: "interrupted" as const,
      reason: "user stopped the run",
      content: "工具执行被中断：user stopped the run",
    },
    {
      terminalStatus: "failed" as const,
      reason: "provider stream disconnected",
      content: "工具执行因 Run 失败而终止：provider stream disconnected",
    },
  ])("closes a dangling tool call for $terminalStatus with its reason", ({ terminalStatus, reason, content }) => {
    const messages = [
      {
        id: "current-run:intent:1",
        seq: 1,
        session_id: "session-1",
        role: "assistant",
        content: "searching",
        metadata: { run_id: "current-run", round: 1 },
        created_at: "2026-01-01T00:00:00.000Z",
        thread_key: "root",
        child_agent_id: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "execute_bash", arguments: '{"command":"find /"}' },
        }],
      },
    ] as MessageInfo[];

    const [closed] = buildTerminalToolMessages(messages, {
      sessionId: "session-1",
      runId: "current-run",
      threadKey: "root",
      agentName: "agent-1",
      terminalStatus,
      reason,
    });

    expect(closed).toMatchObject({
      messageId: "current-run:tool:call-1",
      role: "tool",
      toolCallId: "call-1",
      name: "execute_bash",
      content,
      metadata: {
        terminal_tool_result: true,
        terminal_status: terminalStatus,
        terminal_reason: reason,
        run_id: "current-run",
      },
    });
  });

  it("does not close tool calls owned by another active run", () => {
    const messages = [{
      id: "active-run:intent:1",
      seq: 1,
      session_id: "session-1",
      role: "assistant",
      content: "waiting for approval",
      metadata: { run_id: "active-run", round: 1 },
      created_at: "2026-01-01T00:00:00.000Z",
      thread_key: "root",
      child_agent_id: null,
      tool_calls: [{
        id: "call-active",
        type: "function",
        function: { name: "execute_bash", arguments: "{}" },
      }],
    }] as MessageInfo[];

    expect(buildTerminalToolMessages(messages, {
      sessionId: "session-1",
      runId: "recovery-run",
      threadKey: "root",
      agentName: "agent-1",
      terminalStatus: "interrupted",
      reason: "backend restarted",
    })).toEqual([]);
  });

  it("marks a missing failure reason explicitly instead of inventing one", () => {
    const [closed] = buildTerminalToolMessages([{
      id: "run-1:intent:1",
      seq: 1,
      session_id: "session-1",
      role: "assistant",
      content: "calling tool",
      metadata: { run_id: "run-1", round: 1 },
      created_at: "2026-01-01T00:00:00.000Z",
      thread_key: "root",
      child_agent_id: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "search", arguments: "{}" },
      }],
    }] as MessageInfo[], {
      sessionId: "session-1",
      runId: "run-1",
      threadKey: "root",
      agentName: "agent-1",
      terminalStatus: "failed",
      reason: "",
    });

    expect(closed?.metadata).toMatchObject({ terminal_reason: "未提供失败原因" });
    expect(closed?.content).toBe("工具执行因 Run 失败而终止：未提供失败原因");
  });
});

describe("AsyncKernelEventPersister terminal cleanup", () => {
  it("passes a failed reason into dangling tool-call cleanup", async () => {
    const tenantId = createTenantId("tnt_test");
    let finalizeInput: RuntimeFinalizeRunInput | null = null;
    const storage = {
      tenantId,
      operations: {
        finalizeRun: vi.fn(async (input: RuntimeFinalizeRunInput) => {
          finalizeInput = input;
          return { finalMessage: null, records: [], readyResumeInteractionIds: [] };
        }),
      },
    } as unknown as RuntimeStorage;
    const clientEvents = {
      prepare: vi.fn(),
      flush: vi.fn(async () => undefined),
      deliver: vi.fn(async () => undefined),
    };
    const persister = new AsyncKernelEventPersister(storage, clientEvents, {
      tenantId,
      sessionId: "session-1",
      runId: "run-1",
      threadKey: "root",
      agentName: "agent-1",
      agentDisplayName: "Agent 1",
      rootCallId: "root-call-1",
      sessionIdentity: {
        sessionId: "session-1",
        ownerUserId: null,
        visibility: "private",
        originType: "direct",
        originId: null,
        originChannel: "api",
        workspaceId: null,
      },
    });

    await persister.finalize("failed", null, new Error("provider stream disconnected"));

    expect(finalizeInput).toMatchObject({
      status: "failed",
      deleteProviderContinuationThreadKey: "root",
      closeDanglingToolCalls: {
        threadKey: "root",
        agentName: "agent-1",
        terminalStatus: "failed",
        reason: "provider stream disconnected",
      },
    });
  });
});
