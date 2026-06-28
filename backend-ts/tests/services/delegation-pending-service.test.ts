import { describe, expect, it } from "vitest";

import { DelegationPendingService } from "../../src/services/runtime/delegation-pending-service.js";

describe("DelegationPendingService", () => {
  it("wait + resolve：前端回传唤醒等待", async () => {
    const service = new DelegationPendingService();
    const waitPromise = service.wait("call_1");
    setTimeout(() => {
      service.resolve("call_1", { ok: true, observation: "done" });
    }, 5);
    const resolution = await waitPromise;
    expect(resolution.ok).toBe(true);
    expect(resolution.observation).toBe("done");
  });

  it("resolve 命中 pending 返回 true 并清理（重复 resolve 返回 false）", async () => {
    const service = new DelegationPendingService();
    const waitPromise = service.wait("call_1");
    expect(service.resolve("call_1", { ok: true })).toBe(true);
    await waitPromise;
    expect(service.resolve("call_1", { ok: true })).toBe(false);
  });

  it("resolve 未注册的 callId 返回 false", () => {
    const service = new DelegationPendingService();
    expect(service.resolve("unknown", { ok: true })).toBe(false);
  });

  it("超时自动 reject", async () => {
    const service = new DelegationPendingService({ defaultDeadlineMs: 10 });
    await expect(service.wait("call_timeout")).rejects.toThrow(/超时/);
  });

  it("abort signal 触发 reject", async () => {
    const service = new DelegationPendingService();
    const controller = new AbortController();
    const waitPromise = service.wait("call_abort", { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(waitPromise).rejects.toThrow(/取消/);
  });

  it("已 aborted 的 signal 立即 reject", async () => {
    const service = new DelegationPendingService();
    const controller = new AbortController();
    controller.abort();
    await expect(service.wait("call_aborted", { signal: controller.signal })).rejects.toThrow(/取消/);
  });
});
