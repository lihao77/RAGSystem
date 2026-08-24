import { afterEach, describe, expect, it, vi } from "vitest";

import { AsyncKernelEventPersister } from "../src/services/agent/sdk/async-event-persister.js";

function makePersister(renewRunLease: () => Promise<{ renewed: boolean; expiresAt: string | null }>) {
  const storage = {
    tenantId: "t1",
    operations: {
      renewRunLease: vi.fn(renewRunLease),
      startRun: vi.fn(async () => ({ kind: "started" })),
      finalizeRun: vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] })),
    },
  };
  const clientEvents = {
    prepare: vi.fn(),
    deliver: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
  };
  const ctx = {
    tenantId: "t1",
    sessionId: "s1",
    runId: "r1",
    threadKey: "root",
    agentName: "agent",
    agentDisplayName: "Agent",
    rootCallId: "c1",
    sessionIdentity: {},
  };
  return new AsyncKernelEventPersister(storage as never, clientEvents as never, ctx as never);
}

const deltaEvent = { type: "output_delta", content: "x", partIndex: 0 } as never;

describe("AsyncKernelEventPersister 租约失败闩", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("心跳续期连续失败（分区）后置闩，下一事件 fail-fast；单次瞬时失败不置闩", async () => {
    vi.useFakeTimers();
    const renewRunLease = vi.fn(async (): Promise<{ renewed: boolean; expiresAt: string | null }> => {
      throw new Error("db unreachable");
    });
    const persister = makePersister(renewRunLease);
    await persister.startRun();

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(persister.persist(deltaEvent)).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(persister.persist(deltaEvent)).rejects.toThrow("db unreachable");
  });

  it("续期返回 renewed=false（租约被接管）立即置闩", async () => {
    vi.useFakeTimers();
    const renewRunLease = vi.fn(async () => ({ renewed: false, expiresAt: null }));
    const persister = makePersister(renewRunLease);
    await persister.startRun();

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(persister.persist(deltaEvent)).rejects.toThrow(/lease was lost/);
  });

  it("finalize 保留完整租约确认（终局前实际续期一次）", async () => {
    const renewRunLease = vi.fn(async () => ({ renewed: true, expiresAt: null }));
    const persister = makePersister(renewRunLease);
    await persister.startRun();
    const before = renewRunLease.mock.calls.length;
    await persister.finalize("completed", { content: "done" });
    expect(renewRunLease.mock.calls.length).toBeGreaterThan(before);
  });
});
