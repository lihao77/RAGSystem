import { describe, expect, it } from "vitest";

import { ExecutionRecorder } from "../../src/services/agent/execution/recorder.js";
import type {
  ConversationStore,
  OutboxRow,
} from "../../src/contracts/conversation-store/index.js";
import type { MessageInfo } from "../../src/contracts/session.js";

const INTERRUPTED_BASE = {
  sessionId: "s1",
  runId: "r1",
  taskId: "t1",
  requestId: "req1",
  rootCallId: "call_root",
  agentName: "orchestrator_agent",
  agentDisplayName: "编排",
  errorMessage: "aborted",
  agentResult: "[已停止生成]",
  childAgentId: null,
  threadKey: "root",
  runEndStepPayload: { kind: "run", phase: "end", status: "interrupted" },
  finalMetadata: { agent: "orchestrator_agent", run_id: "r1" },
};

interface ToolCallSeed {
  id: string;
  name: string;
  arguments?: string;
}

function makeIntentAssistant(
  toolCalls: ToolCallSeed[],
  overrides: { metadata?: Record<string, unknown>; id?: string } = {},
): MessageInfo {
  return {
    id: overrides.id ?? "intent-1",
    seq: 1,
    session_id: "s1",
    role: "assistant",
    content: "",
    metadata: {
      run_id: "r1",
      agent_name: "orchestrator_agent",
      round: 1,
      msg_type: "intent",
      react_intermediate: true,
      ...overrides.metadata,
    },
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments ?? "{}" },
    })),
    tool_call_id: null,
    name: null,
  } as unknown as MessageInfo;
}

function makeToolObservation(callId: string, name = "read_file"): MessageInfo {
  return {
    id: `obs-${callId}`,
    seq: 2,
    session_id: "s1",
    role: "tool",
    content: "ok",
    metadata: { run_id: "r1", msg_type: "observation" },
    tool_calls: [],
    tool_call_id: callId,
    name,
  } as unknown as MessageInfo;
}

interface TxRecorder {
  messages: Array<Record<string, unknown>>;
  runSteps: Array<Record<string, unknown>>;
  outbox: Array<Record<string, unknown>>;
}

function makeRecorderStore(messages: MessageInfo[]): { store: ConversationStore; tx: TxRecorder } {
  const tx: TxRecorder = { messages: [], runSteps: [], outbox: [] };
  const mockTx = {
    addMessage: (input: Record<string, unknown>) => {
      tx.messages.push(input);
      return {
        id: `m${tx.messages.length}`,
        seq: tx.messages.length,
        role: input.role,
        content: input.content,
        metadata: (input.metadata as Record<string, unknown>) ?? {},
        tool_calls: [],
        tool_call_id: (input.toolCallId as string) ?? null,
        name: (input.name as string) ?? null,
      } as MessageInfo;
    },
    addRunStep: (input: Record<string, unknown>) => {
      tx.runSteps.push(input);
      return {
        id: tx.runSteps.length,
        run_id: input.runId,
        step_order: tx.runSteps.length,
        step_type: input.stepType,
      };
    },
    updateRunStepsMessageId: () => 0,
    updateRunStatus: () => true,
    appendOutbox: (input: Record<string, unknown>) => {
      tx.outbox.push(input);
      return {
        id: tx.outbox.length,
        ...input,
        status: "delivered",
        created_at: "",
        locked_at: null,
        attempts: 0,
        last_error: null,
        event_id: `e${tx.outbox.length}`,
        session_seq: tx.outbox.length,
      } as OutboxRow;
    },
  };
  const store = {
    listMessages: () => ({
      items: messages,
      total: messages.length,
      limit: 1000,
      offset: 0,
      has_more: false,
    }),
    runInTransaction: (op: (t: typeof mockTx) => unknown) => op(mockTx),
  } as unknown as ConversationStore;
  return { store, tx };
}

function envelopeOf(row: OutboxRow): { type?: string; call_id?: string; payload?: Record<string, unknown> } {
  const payload = row.payload as { client_event?: Record<string, unknown> } | undefined;
  return (payload?.client_event ?? {}) as { type?: string; call_id?: string; payload?: Record<string, unknown> };
}

describe("ExecutionRecorder interrupted 收口悬空工具调用（基于 messages 表）", () => {
  it("为悬空 tool_use 补 tool_result（run_step + role:tool 消息 + envelope）", () => {
    const messages = [makeIntentAssistant([{ id: "call_x", name: "read_file" }])];
    const { store, tx } = makeRecorderStore(messages);
    const recorder = new ExecutionRecorder(store);

    const record = recorder.recordRunTerminal({
      status: "interrupted",
      errorType: "InterruptedError",
      ...INTERRUPTED_BASE,
    });

    const toolEndStep = tx.runSteps.find(
      (s) => (s.payload as Record<string, unknown>)?.kind === "tool"
        && (s.payload as Record<string, unknown>)?.phase === "end",
    );
    expect(toolEndStep).toBeTruthy();
    expect(toolEndStep?.payload).toMatchObject({
      tool_call_id: "call_x",
      tool_name: "read_file",
      status: "error",
      observation: "工具执行被中断",
    });

    const toolMessage = tx.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({
      role: "tool",
      toolCallId: "call_x",
      name: "read_file",
      content: "工具执行被中断",
    });

    const toolResultEnvelope = record.outboxRows.map(envelopeOf).find((e) => e.type === "tool_result");
    expect(toolResultEnvelope).toMatchObject({
      type: "tool_result",
      call_id: "call_x",
      payload: { phase: "end", ok: false, status: "failed" },
    });
  });

  it("覆盖早中断：tool_call 事件未落 run_step（messages 有 tool_use、无 tool step）仍收口", () => {
    // 早中断：abort 在 assistant_intermediate 落库后、tool_call 事件落库前。
    // messages 表有 intent assistant(tool_use)，但 run_step 表无 tool_call start。
    const messages = [makeIntentAssistant([{ id: "early_call", name: "execute_bash" }])];
    const { store, tx } = makeRecorderStore(messages);
    const recorder = new ExecutionRecorder(store);

    const record = recorder.recordRunTerminal({
      status: "interrupted",
      errorType: "InterruptedError",
      ...INTERRUPTED_BASE,
    });

    expect(tx.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["early_call"]);
    expect(record.outboxRows.map(envelopeOf).find((e) => e.type === "tool_result")?.call_id).toBe("early_call");
  });

  it("已有配对 tool result 的 tool_use 不算悬空", () => {
    const messages = [
      makeIntentAssistant([{ id: "call_done", name: "read_file" }]),
      makeToolObservation("call_done"),
    ];
    const { store, tx } = makeRecorderStore(messages);
    const recorder = new ExecutionRecorder(store);

    recorder.recordRunTerminal({
      status: "interrupted",
      errorType: "InterruptedError",
      ...INTERRUPTED_BASE,
    });

    expect(tx.messages.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("多个悬空 tool_use 逐个收口", () => {
    const messages = [
      makeIntentAssistant([
        { id: "call_a", name: "read_file" },
        { id: "call_b", name: "execute_bash" },
      ]),
    ];
    const { store, tx } = makeRecorderStore(messages);
    const recorder = new ExecutionRecorder(store);

    const record = recorder.recordRunTerminal({
      status: "interrupted",
      errorType: "InterruptedError",
      ...INTERRUPTED_BASE,
    });

    expect(tx.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId).sort()).toEqual([
      "call_a",
      "call_b",
    ]);
    expect(
      record.outboxRows.map(envelopeOf).filter((e) => e.type === "tool_result").map((e) => e.call_id).sort(),
    ).toEqual(["call_a", "call_b"]);
  });

  it("部分配对：只为无配对的 tool_use 收口", () => {
    const messages = [
      makeIntentAssistant([
        { id: "call_answered", name: "read_file" },
        { id: "call_dangling", name: "execute_bash" },
      ]),
      makeToolObservation("call_answered"),
    ];
    const { store, tx } = makeRecorderStore(messages);
    const recorder = new ExecutionRecorder(store);

    recorder.recordRunTerminal({
      status: "interrupted",
      errorType: "InterruptedError",
      ...INTERRUPTED_BASE,
    });

    expect(tx.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["call_dangling"]);
  });

  it("不误收口其他 run 的 tool_use（按 metadata.run_id 过滤）", () => {
    const messages = [
      makeIntentAssistant([{ id: "other_run_call", name: "read_file" }], {
        metadata: { run_id: "r_other" },
      }),
    ];
    const { store, tx } = makeRecorderStore(messages);
    const recorder = new ExecutionRecorder(store);

    recorder.recordRunTerminal({
      status: "interrupted",
      errorType: "InterruptedError",
      ...INTERRUPTED_BASE,
    });

    expect(tx.messages.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("failed（非 interrupted）不收口悬空 tool_use", () => {
    const messages = [makeIntentAssistant([{ id: "call_x", name: "read_file" }])];
    const { store, tx } = makeRecorderStore(messages);
    const recorder = new ExecutionRecorder(store);

    recorder.recordRunTerminal({
      status: "failed",
      errorType: "ExecutionError",
      ...INTERRUPTED_BASE,
    });

    expect(tx.messages.filter((m) => m.role === "tool")).toHaveLength(0);
  });
});
