import { describe, expect, it, vi } from "vitest";

import { AgentExecutionStatusTracker } from "../src/services/agent/execution/status-tracker.js";

describe("status tracker run 控制面（流式快照注册表）", () => {
  it("注册后可按 runId 触发；注销需身份匹配；未注册 no-op", async () => {
    const tracker = new AgentExecutionStatusTracker();
    await tracker.emitStreamSnapshot("run-absent");

    const emit = vi.fn(async () => undefined);
    tracker.registerStreamSnapshot("run-1", emit);
    await tracker.emitStreamSnapshot("run-1");
    expect(emit).toHaveBeenCalledOnce();

    // 身份不匹配的注销不得清掉现注册（旧 emitter 的迟到清理场景）。
    tracker.unregisterStreamSnapshot("run-1", vi.fn(async () => undefined));
    await tracker.emitStreamSnapshot("run-1");
    expect(emit).toHaveBeenCalledTimes(2);

    tracker.unregisterStreamSnapshot("run-1", emit);
    await tracker.emitStreamSnapshot("run-1");
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("同 runId 重注册覆盖（resume 复用 runId），旧 emitter 的注销不清新注册", async () => {
    const tracker = new AgentExecutionStatusTracker();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    tracker.registerStreamSnapshot("run-1", first);
    tracker.registerStreamSnapshot("run-1", second);
    tracker.unregisterStreamSnapshot("run-1", first);
    await tracker.emitStreamSnapshot("run-1");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("emitter 抛错被吞掉——best-effort 取像不得掐断重连握手", async () => {
    const tracker = new AgentExecutionStatusTracker();
    tracker.registerStreamSnapshot("run-1", () => Promise.reject(new Error("journal poisoned")));
    await expect(tracker.emitStreamSnapshot("run-1")).resolves.toBeUndefined();
  });
});
