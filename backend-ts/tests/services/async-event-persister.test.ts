import { describe, expect, it } from "vitest";
import { AsyncKernelEventPersister } from "../../src/services/agent/sdk/async-event-persister.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

describe("AsyncKernelEventPersister", () => {
  it("persists run, incremental messages, and final status through async ports", async () => {
    const messages = new Map<string, { id: string; seq: number; content: string }>();
    const runs = new Map<string, { final_message_id: string | null }>();
    const conversation = {
      createSession: async () => undefined,
      addMessage: async (input: { messageId?: string; content: string }) => { const value = { id: input.messageId ?? `m-${messages.size + 1}`, seq: messages.size + 1, content: input.content }; messages.set(value.id, value); return value; },
      getMessageById: async (_session: string, id: string) => messages.get(id) ?? null,
    } as never;
    const runStore = {
      createRun: async (input: { runId: string }) => { runs.set(input.runId, { final_message_id: null }); return { run_id: input.runId, session_id: "s", status: "running", thread_key: "root", parent_run_id: null, parent_call_id: null, child_agent_id: null }; },
      updateRunStatus: async (_tenant: string, id: string, _session: string, _status: string, finalId?: string | null) => { const run = runs.get(id); if (run) run.final_message_id = finalId ?? null; return Boolean(run); },
      getRun: async (_tenant: string, _session: string, id: string) => { const run = runs.get(id); return run ? { final_message_id: run.final_message_id } : null; },
    } as never;
    const snapshots: Array<[string, number]> = [];
    const fileHistory = { makeSnapshot: async (sessionId: string, seq: number) => { snapshots.push([sessionId, seq]); return "snapshot"; } } as never;
    const persister = new AsyncKernelEventPersister(conversation, runStore, { tenantId: LOCAL_TENANT_ID, sessionId: "s", runId: "r", threadKey: "root", agentName: "a" }, fileHistory);
    await persister.startRun();
    await persister.finalize("completed", { content: "answer" });
    expect(await persister.resolveFinalMessage()).toMatchObject({ content: "answer" });
    expect(snapshots).toEqual([["s", 1]]);
  });

  it("mirrors the initial user turn once for future SaaS context reads", async () => {
    const messages = new Map<string, { id: string; seq: number; content: string }>();
    let addCount = 0;
    const conversation = {
      createSession: async () => undefined,
      addMessage: async (input: { messageId?: string; content: string }) => {
        addCount += 1;
        const value = { id: input.messageId ?? `m-${messages.size + 1}`, seq: messages.size + 1, content: input.content };
        messages.set(value.id, value);
        return value;
      },
      getMessageById: async (_session: string, id: string) => messages.get(id) ?? null,
    } as never;
    const runStore = {
      createRun: async (input: { runId: string }) => ({ run_id: input.runId }),
      updateRunStatus: async () => true,
      getRun: async () => null,
    } as never;
    const context = {
      tenantId: LOCAL_TENANT_ID,
      sessionId: "s",
      runId: "r",
      threadKey: "root",
      agentName: "a",
      initialUserMessage: { id: "user-1", content: "question" },
    };

    await new AsyncKernelEventPersister(conversation, runStore, context).startRun();
    await new AsyncKernelEventPersister(conversation, runStore, context).startRun();

    expect(messages.get("user-1")).toMatchObject({ content: "question" });
    expect(addCount).toBe(1);
  });

  it("marks intent and observation messages as intermediate but not the final answer", async () => {
    const added: Array<Record<string, unknown>> = [];
    const conversation = {
      createSession: async () => undefined,
      addMessage: async (input: Record<string, unknown>) => {
        added.push(input);
        return { id: `m-${added.length}`, seq: added.length, content: input.content };
      },
      getMessageById: async () => null,
    } as never;
    const runStore = {
      createRun: async () => ({ run_id: "run-1" }),
      updateRunStatus: async () => true,
      getRun: async () => null,
    } as never;
    const persister = new AsyncKernelEventPersister(conversation, runStore, {
      tenantId: LOCAL_TENANT_ID,
      sessionId: "session-1",
      runId: "run-1",
      threadKey: "root",
      agentName: "agent-1",
    });

    await persister.persist({
      type: "assistant_intermediate",
      message: { role: "assistant", content: "intent" },
      round: 0,
    } as never);
    await persister.persist({
      type: "tool_result",
      observation: "result",
      toolCallId: "call-1",
      toolName: "read_file",
      round: 0,
    } as never);
    await persister.finalize("completed", { content: "final" });

    expect(added.map((input) => input.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(added[0]?.metadata).toMatchObject({ msg_type: "intent", react_intermediate: true });
    expect(added[1]?.metadata).toMatchObject({ msg_type: "observation", react_intermediate: true });
    expect(added[2]?.metadata).toMatchObject({ msg_type: "assistant_final" });
    expect(added[2]?.metadata).not.toHaveProperty("react_intermediate");
  });
});
