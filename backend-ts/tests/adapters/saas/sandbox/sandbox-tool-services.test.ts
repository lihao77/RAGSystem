import { describe, expect, it, vi } from "vitest";
import type { ToolExecContext } from "@ragsystem/agent-sdk";

import type { SandboxLease, SandboxProvider } from "../../../../src/contracts/sandbox/sandbox-provider.js";
import { SandboxLeaseManager } from "../../../../src/adapters/saas/sandbox/sandbox-lease-manager.js";
import { SaaSSandboxBashToolService, SaaSSandboxDocumentToolService } from "../../../../src/adapters/saas/sandbox/sandbox-tool-services.js";

describe("SaaS sandbox tool services", () => {
  it("routes document and bash operations for one run through the same lease", async () => {
    const provider = fakeProvider();
    const leases = new SandboxLeaseManager("tenant-a" as never, provider);
    const documents = new SaaSSandboxDocumentToolService(leases);
    const bash = new SaaSSandboxBashToolService(leases);
    const ctx = context();

    const write = await documents.writeFile({ filePath: "a.txt", content: "hello" }, ctx);
    const prepared = bash.prepareExecution({ command: "ls" }, ctx, null, {} as never);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("expected plan");
    const executed = await bash.executePlan(prepared.plan, ctx);

    expect(write.success).toBe(true);
    expect(executed.success).toBe(true);
    expect(provider.create).toHaveBeenCalledTimes(1);
    const writeLease = (provider.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]![0] as SandboxLease;
    const execLease = (provider.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as SandboxLease;
    expect(writeLease.id).toBe(execLease.id);
    expect((provider.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ path: "/work/a.txt" });
  });

  it("blocks input writes and traversal before creating a sandbox", async () => {
    const provider = fakeProvider();
    const documents = new SaaSSandboxDocumentToolService(new SandboxLeaseManager("tenant-a" as never, provider));
    const inputWrite = await documents.writeFile({ filePath: "secret.txt", filePathSpace: "uploads", content: "x" }, context());
    const traversal = await documents.readFile({ filePath: "../secret.txt" }, context());
    expect(inputWrite.success).toBe(false);
    expect(traversal.success).toBe(false);
    expect(provider.create).not.toHaveBeenCalled();
  });
});

function context(): ToolExecContext {
  return {
    userId: "user-a", sessionId: "session-a", runId: "run-a", taskId: null, requestId: null,
    parentCallId: null, toolCallId: "tool-a", round: 1, order: 1, roundIndex: 1,
  };
}

function fakeProvider(): SandboxProvider {
  const lease: SandboxLease = { id: "sandbox-a", owner: { tenantId: "tenant-a" as never, userId: "user-a", sessionId: "session-a", runId: "run-a" }, createdAt: new Date().toISOString() };
  return {
    create: vi.fn(async () => lease), destroy: vi.fn(async () => undefined),
    readFile: vi.fn(async () => ({ content: "hello", size: 5 })), writeFile: vi.fn(async () => ({ size: 5 })),
    editFile: vi.fn(async () => ({ size: 5, replacements: 1 })), glob: vi.fn(async () => ({ files: [], truncated: false })),
    grep: vi.fn(async () => ({ matches: [], scannedFiles: 0, truncated: false })), previewFile: vi.fn(async () => ({ fileType: "text", fileSize: 5, structure: {} })),
    exec: vi.fn(async () => ({ stdout: "a.txt\n", stderr: "", returnCode: 0, interrupted: false })),
    executeCode: vi.fn(async () => ({ stdout: "", stderr: "", returnCode: 0, interrupted: false, result: null })),
  };
}
