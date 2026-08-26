import { describe, expect, it } from "vitest";

import { applyEnvelope, createExecutionTreeState, getExecutionTree } from "../src/execution-tree.js";

const started = (timestamp: number | string) => ({
  type: "agent_started" as const,
  session_id: "s-1",
  run_id: "r-1",
  agent_id: "tester",
  call_id: "call-root",
  timestamp,
  payload: { phase: "start" as const },
});

const ended = (timestamp: number | string) => ({
  type: "agent_ended" as const,
  session_id: "s-1",
  run_id: "r-1",
  agent_id: "tester",
  call_id: "call-root",
  timestamp,
  payload: { phase: "end" as const, status: "succeeded" as const, success: true },
});

describe("execution tree agent lifecycle time", () => {
  it("顶层 timestamp（int 秒 / ISO）归一化为 ms epoch 落 startedAt/endedAt", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, started(1767225600) as never);
    applyEnvelope(state, ended("2026-01-01T00:00:30.000Z") as never);
    const root = getExecutionTree(state).root;
    expect(root.startedAt).toBe(1767225600000);
    expect(root.endedAt).toBe(Date.parse("2026-01-01T00:00:30.000Z"));
  });

  it("缺 timestamp 不落字段；terminal-only 流的 agent_ended 用 endedAt 兜底 startedAt", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, started(1767225600) as never);
    applyEnvelope(state, { ...ended("2026-01-01T00:00:30.000Z"), timestamp: undefined } as never);
    let root = getExecutionTree(state).root;
    expect(root.startedAt).toBe(1767225600000);
    expect(root.endedAt).toBeUndefined();

    // 历史合成可能只有 agent_ended（无 agent_started）：startedAt 以 endedAt 兜底，
    // 前端时长降级为 0 而不是 NaN。
    const terminalOnly = createExecutionTreeState();
    applyEnvelope(terminalOnly, ended("2026-01-01T00:00:30.000Z") as never);
    root = getExecutionTree(terminalOnly).root;
    expect(root.endedAt).toBe(Date.parse("2026-01-01T00:00:30.000Z"));
    expect(root.startedAt).toBe(root.endedAt);
  });
});
