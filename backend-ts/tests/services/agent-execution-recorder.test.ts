import { describe, expect, it } from "vitest";

import { ExecutionRecorder } from "../../src/services/agent/execution/recorder.js";
import type {
  ConversationStore,
  OutboxRow,
} from "../../src/contracts/conversation-store/index.js";
import type { RunStepInfo } from "../../src/contracts/common.js";
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

function makeToolStep(
  phase: "start" | "end",
  overrides: Record<string, unknown> = {},
): RunStepInfo {
  const callId = (overrides.tool_call_id as string) ?? (overrides.call_id as string) ?? "call_x";
  return {
    id: 1,
    run_id: "r1",
    session_id: "s1",
    message_id: null,
    step_order: 1,
    step_type: "execution.step",
    created_at: "",
    payload: {
      kind: "tool",
      phase,
      step_id: `${callId}:tool`,
      parent_step_id: "call_root:round:0",
      agent_name: "orchestrator_agent",
      agent_display_name: "编排",
      tool_name: "read_file",
      call_id: callId,
      tool_call_id: callId,
      parent_call_id: "call_root",
      arguments: {},
      round: 0,
      order: 1,
      round_index: 1,
      run_id: "r1",
      task_id: "t1",
      request_id: "req1",
      ...(phase === "end"
        ? { status: "success", success: true, summary: "ok", observation: "ok" }
        : { status: "running" }),
      ...overrides,
    },
  };
}

interface TxRecorder {
  messages: Array<Record<string, unknown>>;
  runSteps: Array<Record<string, unknown>>;
  outbox: Array<Record<string, unknown>>;
}

function makeRecorderStore(steps: RunStepInfo[]): { store: ConversationStore; tx: TxRecorder } {
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
    listRunSteps: () => steps,
    runInTransaction: (op: (t: typeof mockTx) => unknown) => op(mockTx),
  } as unknown as ConversationStore;
  return { store, tx };
}

function envelopeOf(row: OutboxRow): { type?: string; call_id?: string; payload?: Record<string, unknown> } {
  const payload = row.payload as { client_event?: Record<string, unknown> } | undefined;
  return (payload?.client_event ?? {}) as { type?: string; call_id?: string; payload?: Record<string, unknown> };
}

describe("ExecutionRecorder interrupted 收口悬空工具调用", () => {
  it("为「已 start 未 end」的悬空工具补 tool_result（run_step + role:tool 消息 + envelope）", () => {
    const steps = [makeToolStep("start", { tool_call_id: "call_x", tool_name: "read_file" })];
    const { store, tx } = makeRecorderStore(steps);
    const recorder = new ExecutionRecorder(store);

    const record = recorder.recordRunTerminal({
      status: "interrupted",
      errorType: "InterruptedError",
      ...INTERRUPTED_BASE,
    });

    // run_step：补一条 kind=tool, phase=end, status=error
    const toolEndStep = tx.runSteps.find(
      (s) => (s.payload as Record<string, unknown>)?.kind === "tool"
        && (s.payload as Record<string, unknown>)?.phase === "end",
    );
    expect(toolEndStep).toBeTruthy();
    expect(toolEndStep?.payload).toMatchObject({
      tool_call_id: "call_x",
      tool_name: "read_file",
      status: "error",
      success: false,
      observation: "工具执行被中断",
    });

    // role:tool observation 消息：配对 intent assistant 的 tool_use（解厂商 API 报错）
    const toolMessage = tx.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({
      role: "tool",
      toolCallId: "call_x",
      name: "read_file",
      content: "工具执行被中断",
    });
    expect(toolMessage?.metadata).toMatchObject({ msg_type: "observation", interrupted: true });

    // envelope：root run 产出 tool_result（WS 投影/回放自洽）
    const toolResultEnvelope = record.outboxRows.map(envelopeOf).find((e) => e.type === "tool_result");
    expect(toolResultEnvelope).toMatchObject({
      type: "tool_result",
      call_id: "call_x",
      payload: { phase: "end", ok: false, status: "failed" },
    });
    // 终态 envelope 仍正常产出
    expect(record.outboxRows.map(envelopeOf).map((e) => e.type)).toEqual(
      expect.arrayContaining(["tool_result", "agent_ended", "run_ended"]),
    );
  });

  it("无工具调用时不补 tool_result", () => {
    const { store, tx } = makeRecorderStore([]);
    const recorder = new ExecutionRecorder(store);

    const record = recorder.recordRunTerminal({
      status: "interrupted",
      errorType: "InterruptedError",
      ...INTERRUPTED_BASE,
    });

    expect(tx.messages.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(tx.runSteps.filter((s) => (s.payload as Record<string, unknown>)?.kind === "tool")).toHaveLength(0);
    expect(record.outboxRows.map(envelopeOf).map((e) => e.type)).not.toContain("tool_result");
  });

  it("已 end 的工具不算悬空，不重复补 tool_result", () => {
    const steps = [
      makeToolStep("start", { tool_call_id: "call_done" }),
      makeToolStep("end", { tool_call_id: "call_done" }),
    ];
    const { store, tx } = makeRecorderStore(steps);
    const recorder = new ExecutionRecorder(store);

    recorder.recordRunTerminal({
      status: "interrupted",
      errorType: "InterruptedError",
      ...INTERRUPTED_BASE,
    });

    expect(tx.messages.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("多个悬空工具逐个收口", () => {
    const steps = [
      makeToolStep("start", { tool_call_id: "call_a", tool_name: "read_file" }),
      makeToolStep("start", { tool_call_id: "call_b", tool_name: "execute_bash" }),
    ];
    const { store, tx } = makeRecorderStore(steps);
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
    expect(record.outboxRows.map(envelopeOf).filter((e) => e.type === "tool_result").map((e) => e.call_id).sort()).toEqual([
      "call_a",
      "call_b",
    ]);
  });

  it("failed（非 interrupted）不收口悬空工具", () => {
    const steps = [makeToolStep("start", { tool_call_id: "call_x" })];
    const { store, tx } = makeRecorderStore(steps);
    const recorder = new ExecutionRecorder(store);

    recorder.recordRunTerminal({
      status: "failed",
      errorType: "ExecutionError",
      ...INTERRUPTED_BASE,
    });

    expect(tx.messages.filter((m) => m.role === "tool")).toHaveLength(0);
  });
});
