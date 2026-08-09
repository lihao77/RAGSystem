import { describe, expect, it, vi } from "vitest";

import {
  buildRunTerminalRecords,
  buildTerminalAssistantMessage,
  buildTerminalToolMessages,
} from "../src/contracts/storage/runtime-finalization.js";
import type { RuntimeFinalizeRunInput, RuntimeStorage } from "../src/contracts/storage/runtime-storage.js";
import type { MessageInfo } from "../src/contracts/session/session.js";
import { createTenantId } from "../src/identity/types.js";
import { AsyncKernelEventPersister } from "../src/services/agent/sdk/async-event-persister.js";
import { filterHistoryMessages, messagesToConversation } from "../src/services/agent/context/history-view.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

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
        content_parts: [{ type: "text", text: "searching" }],
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
      content_parts: [{ type: "text", text: "waiting for approval" }],
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
      content_parts: [{ type: "text", text: "calling tool" }],
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

describe("buildTerminalAssistantMessage", () => {
  it.each([
    {
      terminalStatus: "failed" as const,
      reason: "provider stream disconnected",
      content: "本次运行执行失败：provider stream disconnected",
    },
    {
      terminalStatus: "interrupted" as const,
      reason: "session_stopped",
      content: "本次运行已中断，未生成最终答案。原因：用户主动停止运行",
    },
  ])("persists a non-empty $terminalStatus context boundary", ({ terminalStatus, reason, content }) => {
    const message = buildTerminalAssistantMessage({
      sessionId: "session-1",
      runId: "run-1",
      threadKey: "root",
      agentName: "agent-1",
      terminalStatus,
      reason,
    });
    expect(message.messageId).toBe("run-1:terminal");
    expect(message.content).toBe(content);
    expect(message.contentParts).toEqual([{ type: "text", text: content }]);
    expect(message.metadata).toMatchObject({
      msg_type: "run_terminal",
      terminal_status: terminalStatus,
      terminal_reason: reason,
      visible_to_user: true,
    });
  });

  it("remains in the next model context as an explicit assistant boundary", () => {
    const input = buildTerminalAssistantMessage({
      sessionId: "session-1",
      runId: "run-1",
      threadKey: "root",
      agentName: "agent-1",
      terminalStatus: "failed",
      reason: "provider stream disconnected",
    });
    const message = {
      ...input,
      id: input.messageId,
      seq: 2,
      session_id: input.sessionId,
      created_at: "2026-01-01T00:00:00.000Z",
      thread_key: input.threadKey ?? "root",
      child_agent_id: null,
      metadata: input.metadata ?? {},
      content_parts: input.contentParts ?? [],
    } as MessageInfo;
    const history = filterHistoryMessages([message]);
    expect(history).toHaveLength(1);
    expect(messagesToConversation(history).conversation).toEqual([
      { role: "assistant", content: "本次运行执行失败：provider stream disconnected" },
    ]);
  });
});

describe("AsyncKernelEventPersister terminal cleanup", () => {
  it("persists canonical content_parts and publishes the same final content parts", async () => {
    const tenantId = createTenantId("tnt_test");
    let finalizeInput: RuntimeFinalizeRunInput | null = null;
    let terminalEvents: unknown[] = [];
    const storage = {
      tenantId,
      operations: {
        finalizeRun: vi.fn(async (input: RuntimeFinalizeRunInput) => {
          finalizeInput = input;
          const finalMessage = {
            id: input.finalMessage!.messageId,
            seq: 2,
            session_id: input.sessionId,
            role: "assistant",
            content: input.finalMessage!.content,
            content_parts: input.finalMessage!.contentParts ?? [],
            metadata: input.finalMessage!.metadata ?? {},
            created_at: "2026-01-01T00:00:00.000Z",
            thread_key: "root",
            child_agent_id: null,
          } as MessageInfo;
          terminalEvents = buildRunTerminalRecords({
            run: {
              sessionId: input.sessionId,
              runId: input.runId,
              agentCallId: "root-call-1",
              lineageParentCallId: null,
              agentName: "agent-1",
              agentDisplayName: "Agent 1",
            },
            status: input.status as "completed" | "failed" | "interrupted",
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            finalMessage,
          })
            .map((record) => record.outbox.payload.client_event);
          return { finalMessage, records: [], readyResumeInteractionIds: [] };
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
      teamSnapshot: createTestTeamSnapshot(),
      },
    });

    await persister.finalize("completed", {
      content: "Map: \n\nFile: map.png (results/map.png)\n\n",
      contentParts: [
        { type: "text", text: "Map: " },
        { type: "file_ref", filePath: "results/map.png", presentation: "inline" },
      ],
    });

    expect(finalizeInput).not.toBeNull();
    const completedFinalizeInput = finalizeInput as unknown as RuntimeFinalizeRunInput;
    expect(completedFinalizeInput.finalMessage?.contentParts).toEqual([
      { type: "text", text: "Map: " },
      { type: "file_ref", file_path: "results/map.png", presentation: "inline" },
    ]);
    expect(terminalEvents[0]).toMatchObject({
      type: "stream_output",
      payload: { phase: "final", content_parts: [{ type: "text" }, { type: "file_ref", file_path: "results/map.png" }] },
    });
  });

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
      teamSnapshot: createTestTeamSnapshot(),
      },
    });

    await persister.finalize("failed", null, new Error("provider stream disconnected"));

    expect(finalizeInput).toMatchObject({
      status: "failed",
      closeDanglingToolCalls: {
        threadKey: "root",
        agentName: "agent-1",
        terminalStatus: "failed",
        reason: "provider stream disconnected",
      },
    });
  });

  it("publishes an interrupted terminal agent event for a foreground child aborted with its parent", async () => {
    const tenantId = createTenantId("tnt_test");
    let terminalEvents: Array<{ type: string }> = [];
    const storage = {
      tenantId,
      operations: {
        finalizeRun: vi.fn(async (input: RuntimeFinalizeRunInput) => {
          const finalMessage = {
            id: input.finalMessage!.messageId,
            seq: 2,
            session_id: input.sessionId,
            role: "assistant",
            content: input.finalMessage!.content,
            content_parts: input.finalMessage!.contentParts ?? [],
            metadata: input.finalMessage!.metadata ?? {},
            created_at: "2026-01-01T00:00:00.000Z",
            thread_key: "child:child-1",
            child_agent_id: "child-1",
          } as MessageInfo;
          terminalEvents = buildRunTerminalRecords({
            run: {
              sessionId: input.sessionId,
              runId: input.runId,
              agentCallId: "child-call-1",
              lineageParentCallId: "root-call-1",
              agentName: "worker",
              agentDisplayName: "Worker",
            },
            status: input.status as "completed" | "failed" | "interrupted",
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            finalMessage,
          })
            .map((record) => record.outbox.payload.client_event as { type: string });
          return { finalMessage, records: [], readyResumeInteractionIds: [] };
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
      runId: "child-run-1",
      threadKey: "child:child-1",
      agentName: "worker",
      agentDisplayName: "Worker",
      rootCallId: "child-call-1",
      rootRunId: "root-run-1",
      parentRunId: "root-run-1",
      parentCallId: "root-call-1",
      lineageParentCallId: "root-call-1",
      childAgentId: "child-1",
      sessionIdentity: {
        sessionId: "session-1",
        ownerUserId: null,
        visibility: "private",
        originType: "direct",
        originId: null,
        originChannel: "api",
      workspaceId: null,
      teamSnapshot: createTestTeamSnapshot(),
      },
    });

    await persister.finalize("interrupted", null, new Error("session_stopped"));

    expect(terminalEvents.map((event) => event.type)).toContain("agent_ended");
    expect(terminalEvents.map((event) => event.type)).toContain("run_ended");
  });
});
