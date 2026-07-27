import { describe, expect, it, vi } from "vitest";
import type { ToolExecContext } from "@ragsystem/agent-sdk";

import type { SandboxLease, SandboxProvider } from "../../../../src/contracts/sandbox/sandbox-provider.js";
import { SandboxLeaseManager, type SandboxLeaseLifecycle } from "../../../../src/adapters/saas/sandbox/sandbox-lease-manager.js";

describe("SandboxLeaseManager", () => {
  it("shares a lease only for the same tenant/user/session/run identity", async () => {
    const provider = fakeProvider();
    const manager = new SandboxLeaseManager("tenant-a" as never, provider);
    const first = context({ userId: "user-a", runId: "run-a" });

    const [leaseA, leaseAAgain] = await Promise.all([manager.getOrCreate(first), manager.getOrCreate(first)]);
    const leaseOtherRun = await manager.getOrCreate(context({ userId: "user-a", runId: "run-b" }));
    const leaseOtherUser = await manager.getOrCreate(context({ userId: "user-b", runId: "run-a" }));

    expect(leaseA.id).toBe(leaseAAgain.id);
    expect(leaseOtherRun.id).not.toBe(leaseA.id);
    expect(leaseOtherUser.id).not.toBe(leaseA.id);
    expect(provider.create).toHaveBeenCalledTimes(3);
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ network: "none" }));
  });

  it("rejects missing ownership identity instead of using a shared anonymous lease", async () => {
    const provider = fakeProvider();
    const manager = new SandboxLeaseManager("tenant-a" as never, provider);
    await expect(manager.getOrCreate(context({ userId: null }))).rejects.toThrow("userId");
    await expect(manager.getOrCreate(context({ sessionId: null }))).rejects.toThrow("sessionId");
    await expect(manager.getOrCreate(context({ runId: null }))).rejects.toThrow("runId");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("destroys leases after a run and on close", async () => {
    const provider = fakeProvider();
    const manager = new SandboxLeaseManager("tenant-a" as never, provider);
    await manager.getOrCreate(context({ runId: "run-a" }));
    await manager.getOrCreate(context({ runId: "run-b" }));

    await manager.releaseRun("session-a", "run-a");
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    await manager.closeAll();
    expect(provider.destroy).toHaveBeenCalledTimes(2);
    await expect(manager.getOrCreate(context({ runId: "run-c" }))).rejects.toThrow("closed");
  });

  it("prepares inputs before exposing a lease and collects outputs before destroy", async () => {
    const provider = fakeProvider();
    const order: string[] = [];
    vi.mocked(provider.destroy).mockImplementation(async () => { order.push("destroy"); });
    const lifecycle: SandboxLeaseLifecycle = {
      prepare: vi.fn(async () => { order.push("prepare"); }),
      collectOutputs: vi.fn(async () => { order.push("collect"); }),
    };
    const manager = new SandboxLeaseManager("tenant-a" as never, provider, 900, lifecycle);

    await manager.getOrCreate(context({ attachmentFileIds: ["file-a"] }));
    expect(order).toEqual(["prepare"]);
    expect(lifecycle.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      provider,
      { attachmentFileIds: ["file-a"] },
    );
    await manager.releaseRun("session-a", "run-a");
    expect(order).toEqual(["prepare", "collect", "destroy"]);
  });

  it("destroys a newly created sandbox when input staging fails", async () => {
    const provider = fakeProvider();
    const lifecycle: SandboxLeaseLifecycle = {
      prepare: vi.fn(async () => { throw new Error("staging failed"); }),
      collectOutputs: vi.fn(async () => undefined),
    };
    const manager = new SandboxLeaseManager("tenant-a" as never, provider, 900, lifecycle);

    await expect(manager.getOrCreate(context())).rejects.toThrow("staging failed");
    expect(provider.destroy).toHaveBeenCalledTimes(1);
  });

  it("still destroys the lease and reports a failed output collection", async () => {
    const provider = fakeProvider();
    const lifecycle: SandboxLeaseLifecycle = {
      prepare: vi.fn(async () => undefined),
      collectOutputs: vi.fn(async () => { throw new Error("collection failed"); }),
    };
    const manager = new SandboxLeaseManager("tenant-a" as never, provider, 900, lifecycle);
    await manager.getOrCreate(context());

    await expect(manager.releaseRun("session-a", "run-a")).rejects.toThrow("output collection or cleanup failed");
    expect(provider.destroy).toHaveBeenCalledTimes(1);
  });
});

function context(overrides: Partial<ToolExecContext> = {}): ToolExecContext {
  return {
    sessionId: "session-a", runId: "run-a", userId: "user-a", taskId: null, requestId: null,
    parentCallId: null, toolCallId: null, round: 1, order: 1, roundIndex: 1, ...overrides,
  };
}

function fakeProvider(): SandboxProvider {
  let sequence = 0;
  const create = vi.fn(async ({ owner }: Parameters<SandboxProvider["create"]>[0]): Promise<SandboxLease> => ({
    id: `sandbox-${++sequence}`, owner, createdAt: new Date().toISOString(),
  }));
  return {
    create,
    destroy: vi.fn(async () => undefined),
    stageInputFile: vi.fn(async (_lease, input) => ({ size: Buffer.from(input.content, "base64").byteLength })),
    readFile: vi.fn(async () => ({ content: "", size: 0 })),
    writeFile: vi.fn(async () => ({ size: 0 })),
    editFile: vi.fn(async () => ({ size: 0, replacements: 1 })),
    glob: vi.fn(async () => ({ files: [], truncated: false })),
    grep: vi.fn(async () => ({ matches: [], scannedFiles: 0, truncated: false })),
    previewFile: vi.fn(async () => ({ fileType: "text", fileSize: 0, structure: {} })),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", returnCode: 0, interrupted: false })),
    executeCode: vi.fn(async () => ({ stdout: "", stderr: "", returnCode: 0, interrupted: false, result: null })),
  };
}
