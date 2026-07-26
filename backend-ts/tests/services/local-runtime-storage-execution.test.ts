import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteRuntimeStorage } from "../../src/adapters/local/sqlite-runtime-storage.js";
import { createConversationStore, type ConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import type { OutboxRow } from "../../src/contracts/conversation-store/index.js";
import { AsyncKernelEventPersister } from "../../src/services/agent/sdk/async-event-persister.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { buildExecutionTree } from "@ragsystem/agent-protocol";

const stores: ConversationStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function createHarness(runId: string) {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  stores.push(store);
  const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
  const delivered: OutboxRow[][] = [];
  const dispatcher = {
    dispatchRows: vi.fn(async (rows: OutboxRow[]) => {
      delivered.push(rows);
      for (const row of rows) store.markOutboxDelivered(row.id);
      return [];
    }),
  };
  const publisher = new DurableClientEventPublisher(storage, dispatcher as never);
  const persister = new AsyncKernelEventPersister(storage, publisher, {
    tenantId: LOCAL_TENANT_ID,
    sessionId: `session-${runId}`,
    sessionIdentity: {
      sessionId: `session-${runId}`,
      ownerUserId: "user-1",
      visibility: "private",
      originType: "direct",
      originId: null,
      originChannel: "api",
      workspaceId: null,
    },
    runId,
    rootRunId: runId,
    threadKey: "root",
    agentName: "agent-1",
    agentDisplayName: "Agent One",
    rootCallId: `call-${runId}`,
    userId: "user-1",
  });
  return {
    store,
    storage,
    publisher,
    persister,
    delivered,
    sessionId: `session-${runId}`,
    runId,
  };
}

async function startAndRecordAgentStarted(harness: ReturnType<typeof createHarness>) {
  await harness.persister.startRun();

  expect(harness.store.getRun(harness.sessionId, harness.runId)).toMatchObject({ status: "running" });
  await harness.publisher.publish(harness.sessionId, {
    type: "agent_started",
    session_id: harness.sessionId,
    run_id: harness.runId,
    call_id: `call-${harness.runId}`,
    agent_id: "agent-1",
    payload: { phase: "start", display_name: "Agent One" },
  }, { eventId: `${harness.runId}:agent_started`, runId: harness.runId });

  expect(harness.store.listRunSteps({ sessionId: harness.sessionId, runId: harness.runId }))
    .toEqual([expect.objectContaining({ payload: expect.objectContaining({ type: "agent_started" }), step_order: 1 })]);
}

function terminalRows(harness: ReturnType<typeof createHarness>) {
  return harness.store.listOutboxForReplay({ sessionId: harness.sessionId })
    .filter((row) => row.event_id.startsWith(`${harness.runId}:terminal:`));
}

describe("local RuntimeStorage execution parity", () => {
  it("commits the run before agent_started through the shared SQLite storage and publisher", async () => {
    const harness = createHarness("run-started");

    await startAndRecordAgentStarted(harness);

    expect(harness.store.listOutboxForReplay({ sessionId: harness.sessionId })).toEqual([
      expect.objectContaining({ event_id: "run-started:agent_started", run_id: "run-started" }),
    ]);
    expect(harness.delivered).toEqual([
      [expect.objectContaining({ event_id: "run-started:agent_started" })],
    ]);
  });

  it("stores one completed final message and one deterministic terminal event set across replay", async () => {
    const harness = createHarness("run-completed");
    await startAndRecordAgentStarted(harness);

    await harness.persister.finalize("completed", { content: "answer" });
    await harness.persister.finalize("completed", { content: "answer" });

    const messages = harness.store.listMessages(harness.sessionId).items;
    expect(messages.filter((message) => message.id === "run-completed:final")).toHaveLength(1);
    expect(harness.store.getRun(harness.sessionId, harness.runId)).toMatchObject({
      status: "completed",
      final_message_id: "run-completed:final",
    });
    expect(terminalRows(harness).map((row) => row.event_id)).toEqual([
      "run-completed:terminal:0:stream_output",
      "run-completed:terminal:1:state_sync",
      "run-completed:terminal:2:agent_ended",
      "run-completed:terminal:3:run_ended",
    ]);
    expect(harness.delivered.flat()
      .filter((row) => row.event_id.startsWith("run-completed:terminal:")))
      .toHaveLength(4);
    expect(harness.store.listRunSteps({ sessionId: harness.sessionId, runId: harness.runId }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ type: "agent_started" }),
          message_id: "run-completed:final",
        }),
        expect.objectContaining({
          payload: expect.objectContaining({ type: "stream_output" }),
          message_id: "run-completed:final",
        }),
        expect.objectContaining({
          payload: expect.objectContaining({ type: "agent_ended" }),
          message_id: "run-completed:final",
        }),
      ]));
  });

  it("closes a dangling tool call and stores one interrupted terminal event set", async () => {
    const harness = createHarness("run-interrupted");
    await startAndRecordAgentStarted(harness);
    await harness.persister.persist({
      type: "assistant_intermediate",
      round: 0,
      message: {
        role: "assistant",
        content: "working",
        tool_calls: [{ id: "tool-pending", type: "function", function: { name: "write", arguments: "{}" } }],
      },
    } as never);
    await harness.publisher.publish(harness.sessionId, {
      type: "tool_call",
      session_id: harness.sessionId,
      run_id: harness.runId,
      call_id: "tool-pending",
      agent_id: "agent-1",
      payload: {
        tool: "write",
        input: {},
        phase: "start",
        status: "running",
        lineage: { parent_call_id: `call-${harness.runId}` },
      },
    }, { eventId: `${harness.runId}:tool-pending`, runId: harness.runId });

    await harness.persister.finalize("interrupted", null, new Error("aborted"));
    await harness.persister.finalize("interrupted", null, new Error("aborted"));

    expect(harness.store.listMessages(harness.sessionId).items
      .filter((message) => message.id === "run-interrupted:interrupted")).toHaveLength(1);
    expect(harness.store.getMessageById(harness.sessionId, "run-interrupted:tool:tool-pending"))
      .toMatchObject({
        role: "tool",
        content: "工具执行被中断",
        tool_call_id: "tool-pending",
        metadata: { interrupted: true },
      });
    expect(harness.store.getRun(harness.sessionId, harness.runId)).toMatchObject({
      status: "interrupted",
      final_message_id: "run-interrupted:interrupted",
    });
    expect(terminalRows(harness).map((row) => row.event_id)).toEqual([
      "run-interrupted:terminal:0:tool_result",
      "run-interrupted:terminal:1:agent_ended",
      "run-interrupted:terminal:2:run_ended",
    ]);
    expect(harness.delivered.flat()
      .filter((row) => row.event_id.startsWith("run-interrupted:terminal:")))
      .toHaveLength(3);
    const executionTree = buildExecutionTree(
      harness.store.listRunSteps({ sessionId: harness.sessionId, runId: harness.runId })
        .map((step) => step.payload as never),
    );
    expect(executionTree.root?.rounds[0]?.toolCalls[0]).toMatchObject({
      callId: "tool-pending",
      status: "failed",
      observation: "工具执行被中断",
    });
  });

  it("suspends without a final message or terminal event set", async () => {
    const harness = createHarness("run-suspended");
    await startAndRecordAgentStarted(harness);

    await harness.persister.finalize("suspended", null);
    await harness.persister.finalize("suspended", null);

    expect(harness.store.getRun(harness.sessionId, harness.runId)).toMatchObject({
      status: "suspended",
      final_message_id: null,
    });
    expect(harness.store.listMessages(harness.sessionId).items).toEqual([]);
    expect(terminalRows(harness)).toEqual([]);
  });
});
