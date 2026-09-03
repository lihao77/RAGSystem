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

describe("status tracker 维护类中止注册表（/compact 可停止）", () => {
  it("cancel 触发 abort 并返回 true；未注册返回 false；注销需身份匹配", () => {
    const tracker = new AgentExecutionStatusTracker();
    expect(tracker.cancelMaintenanceAbort("session-1")).toBe(false);

    const controller = new AbortController();
    tracker.registerMaintenanceAbort("session-1", controller);
    expect(tracker.cancelMaintenanceAbort("session-1", "user_stop")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(Error);

    // 已中止的重复 cancel 仍报告 true（幂等——停止入口只关心"有没有东西被停"）。
    expect(tracker.cancelMaintenanceAbort("session-1")).toBe(true);

    // 身份不匹配的注销不清现注册；匹配的注销后 cancel 不再命中。
    const stale = new AbortController();
    tracker.unregisterMaintenanceAbort("session-1", stale);
    const fresh = new AbortController();
    tracker.registerMaintenanceAbort("session-1", fresh);
    tracker.unregisterMaintenanceAbort("session-1", stale);
    expect(tracker.cancelMaintenanceAbort("session-1")).toBe(true);
    expect(fresh.signal.aborted).toBe(true);
    tracker.unregisterMaintenanceAbort("session-1", fresh);
    expect(tracker.cancelMaintenanceAbort("session-1")).toBe(false);
  });
});
