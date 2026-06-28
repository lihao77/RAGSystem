import { describe, expect, it, vi } from "vitest";

import { createHookRegistry } from "@ragsystem/agent-sdk";
import type { ToolExecutionResult } from "@ragsystem/agent-sdk";

// 纯 registry 聚合逻辑测试（不跑 runtime）。内核消费侧（tool.before deny 跳过工具等）
// 经 runtime-core-execution 集成测试覆盖无回归；聚合规则是承重逻辑，单独覆盖。
describe("HookRegistry aggregation", () => {
  const toolCtx = { sessionId: "s1", runId: "r1", toolCallId: "t1" } as never;

  it("returns EMPTY when no handlers registered", async () => {
    const hooks = createHookRegistry();
    const out = await hooks.emit("tool.before", { toolName: "x", arguments: {}, ctx: toolCtx });
    expect(out.decision).toBeUndefined();
    expect(out.modifiedInput).toBeUndefined();
  });

  it("aggregates decisions deny > allow", async () => {
    const hooks = createHookRegistry();
    hooks.on("tool.before", () => ({ decision: "allow", reason: "a" }));
    hooks.on("tool.before", () => ({ decision: "deny", reason: "c" }));
    const out = await hooks.emit("tool.before", { toolName: "x", arguments: {}, ctx: toolCtx });
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("c");
  });

  it("modifiedInput: last non-undefined wins", async () => {
    const hooks = createHookRegistry();
    hooks.on("tool.before", () => ({ modifiedInput: { a: 1 } }));
    hooks.on("tool.before", () => ({ modifiedInput: { a: 2 } }));
    const out = await hooks.emit("tool.before", { toolName: "x", arguments: {}, ctx: toolCtx });
    expect(out.modifiedInput).toEqual({ a: 2 });
  });

  it("modifiedResult: last non-undefined wins", async () => {
    const hooks = createHookRegistry();
    const r1 = { success: true, content: "r1" } as unknown as ToolExecutionResult;
    const r2 = { success: true, content: "r2" } as unknown as ToolExecutionResult;
    hooks.on("tool.after", () => ({ modifiedResult: r1 }));
    hooks.on("tool.after", () => ({ modifiedResult: r2 }));
    const out = await hooks.emit("tool.after", { toolName: "x", arguments: {}, result: r1, ctx: toolCtx });
    expect(out.modifiedResult).toBe(r2);
  });

  it("round.before additionalContext: last non-undefined wins", async () => {
    const hooks = createHookRegistry();
    hooks.on("round.before", () => ({ additionalContext: "first" }));
    hooks.on("round.before", () => ({ additionalContext: "second" }));
    const out = await hooks.emit("round.before", { ctx: { messages: [] } as never, round: 0 });
    expect(out.additionalContext).toBe("second");
  });

  it("merges metadata across handlers (later overrides)", async () => {
    const hooks = createHookRegistry();
    hooks.on("tool.before", () => ({ metadata: { a: 1, shared: "x" } }));
    hooks.on("tool.before", () => ({ metadata: { b: 2, shared: "y" } }));
    const out = await hooks.emit("tool.before", { toolName: "x", arguments: {}, ctx: toolCtx });
    expect(out.metadata).toEqual({ a: 1, b: 2, shared: "y" });
  });

  it("isolates handler errors (one throws, others still run, error recorded)", async () => {
    const hooks = createHookRegistry();
    const survivor = vi.fn(() => ({ decision: "deny" }));
    hooks.on("tool.before", async () => { throw new Error("boom"); });
    hooks.on("tool.before", survivor);
    const out = await hooks.emit("tool.before", { toolName: "x", arguments: {}, ctx: toolCtx });
    expect(survivor).toHaveBeenCalledOnce();
    expect(out.decision).toBe("deny");
    expect(Array.isArray(out.metadata?.hook_errors)).toBe(true);
    expect((out.metadata?.hook_errors as Array<{ message: string }>)[0]?.message).toBe("boom");
  });

  it("unsubscribe stops the handler", async () => {
    const hooks = createHookRegistry();
    const off = hooks.on("tool.before", () => ({ decision: "deny" }));
    off();
    const out = await hooks.emit("tool.before", { toolName: "x", arguments: {}, ctx: toolCtx });
    expect(out.decision).toBeUndefined();
  });

  it("async handlers are awaited in registration order", async () => {
    const order: string[] = [];
    const hooks = createHookRegistry();
    hooks.on("tool.before", async () => { await Promise.resolve(); order.push("a"); return undefined; });
    hooks.on("tool.before", async () => { await Promise.resolve(); order.push("b"); return { decision: "allow" }; });
    await hooks.emit("tool.before", { toolName: "x", arguments: {}, ctx: toolCtx });
    expect(order).toEqual(["a", "b"]);
  });
});

describe("HookRegistry tool.gate 聚合（审批安全网）", () => {
  const gateCtx = { sessionId: "s1", runId: "r1", toolCallId: "t1" } as never;
  const gateInput = {
    toolName: "write_file",
    arguments: { path: "/etc/passwd" },
    ctx: gateCtx,
    riskLevel: "medium",
    access: null,
  };

  it("policy deny 压过消费方 rogue allow（deny>allow 安全网）", async () => {
    const hooks = createHookRegistry();
    hooks.on("tool.gate", () => ({ decision: "allow" }));  // 消费方 rogue allow
    hooks.on("tool.gate", () => ({ decision: "deny", reason: "policy: 越界写入" }));  // policy deny
    const out = await hooks.emit("tool.gate", gateInput);
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("policy: 越界写入");
  });

  it("无 handler 时放行（无 policy = 全 allow）", async () => {
    const hooks = createHookRegistry();
    const out = await hooks.emit("tool.gate", gateInput);
    expect(out.decision).toBeUndefined();
  });
});
