import type { ToolExecContext } from "@ragsystem/agent-sdk";
import { describe, expect, it, vi } from "vitest";

import type {
  SandboxLease,
  SandboxOwner,
  SandboxProvider,
} from "../../../src/contracts/sandbox/sandbox-provider.js";
import { SandboxLeaseManager } from "../../../src/adapters/saas/sandbox/sandbox-lease-manager.js";
import {
  resolveSandboxPath,
  validateSandboxGlob,
} from "../../../src/adapters/saas/sandbox/sandbox-paths.js";
import { createTenantId } from "../../../src/identity/types.js";
import { toolContext } from "../../helpers/tool-context.js";

function context(overrides: Partial<ToolExecContext> = {}): ToolExecContext {
  return toolContext({
    userId: "user-a",
    sessionId: "session-a",
    runId: "run-a",
    ...overrides,
  });
}

function lease(id: string, owner: SandboxOwner): SandboxLease {
  return { id, owner: { ...owner }, createdAt: "2026-07-26T00:00:00.000Z" };
}

function providerHarness() {
  let sequence = 0;
  const create = vi.fn(async (input: Parameters<SandboxProvider["create"]>[0]) =>
    lease(`lease-${++sequence}`, input.owner));
  const destroy = vi.fn(async (_lease: SandboxLease) => undefined);
  const provider: SandboxProvider = {
    create,
    destroy,
    stageInputFile: vi.fn(async (_lease, input) => ({ size: Buffer.from(input.content, "base64").byteLength })),
    readFile: vi.fn(async () => ({ content: "", size: 0 })),
    writeFile: vi.fn(async () => ({ size: 0 })),
    editFile: vi.fn(async () => ({ size: 0, replacements: 0 })),
    glob: vi.fn(async () => ({ files: [], truncated: false })),
    grep: vi.fn(async () => ({ matches: [], scannedFiles: 0, truncated: false })),
    previewFile: vi.fn(async () => ({ fileType: "text", fileSize: 0, structure: {} })),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", returnCode: 0, interrupted: false })),
    executeCode: vi.fn(async () => ({ stdout: "", stderr: "", returnCode: 0, interrupted: false, result: null })),
  };
  return { provider, create, destroy };
}

describe("SaaS sandbox security boundaries", () => {
  it("does not reuse or cross-release leases across tenant, user, session, or run owners", async () => {
    const { provider, create, destroy } = providerHarness();
    const tenantA = createTenantId("tnt_a");
    const tenantB = createTenantId("tnt_b");
    const managerA = new SandboxLeaseManager(tenantA, provider);
    const managerB = new SandboxLeaseManager(tenantB, provider);
    const base = context();
    const otherUser = context({ userId: "user-b" });
    const otherSession = context({ sessionId: "session-b" });
    const otherRun = context({ runId: "run-b" });

    const [baseLease, userLease, sessionLease, runLease, tenantLease] = await Promise.all([
      managerA.getOrCreate(base),
      managerA.getOrCreate(otherUser),
      managerA.getOrCreate(otherSession),
      managerA.getOrCreate(otherRun),
      managerB.getOrCreate(base),
    ]);

    expect(new Set([baseLease.id, userLease.id, sessionLease.id, runLease.id, tenantLease.id]).size).toBe(5);
    expect(create).toHaveBeenCalledTimes(5);

    await managerA.release(otherUser);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(userLease);
    expect(await managerA.getOrCreate(base)).toBe(baseLease);
    expect(await managerA.getOrCreate(otherSession)).toBe(sessionLease);
    expect(await managerA.getOrCreate(otherRun)).toBe(runLease);
    expect(await managerB.getOrCreate(base)).toBe(tenantLease);
    expect(create).toHaveBeenCalledTimes(5);

    await expect(managerA.releaseOwner({ ...baseLease.owner, tenantId: tenantB }))
      .rejects.toThrow("another tenant");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["userId", { userId: null }],
    ["userId", { userId: "   " }],
    ["sessionId", { sessionId: null }],
    ["sessionId", { sessionId: "" }],
    ["runId", { runId: null }],
    ["runId", { runId: "  " }],
  ] as const)("rejects a missing or blank %s before provider creation", async (identity, overrides) => {
    const { provider, create } = providerHarness();
    const manager = new SandboxLeaseManager(createTenantId("tnt_a"), provider);

    await expect(manager.getOrCreate(context(overrides))).rejects.toThrow(`requires ${identity}`);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a provider owner mismatch and removes the failed lease promise from the cache", async () => {
    const { provider } = providerHarness();
    const create = vi.mocked(provider.create);
    create
      .mockImplementationOnce(async (input) => lease("mismatched", { ...input.owner, userId: "other-user" }))
      .mockImplementationOnce(async (input) => lease("valid", input.owner));
    const manager = new SandboxLeaseManager(createTenantId("tnt_a"), provider);
    const ownerContext = context();

    await expect(manager.getOrCreate(ownerContext)).rejects.toThrow("owner mismatch");
    await expect(manager.getOrCreate(ownerContext)).resolves.toMatchObject({ id: "valid" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent getOrCreate calls into one provider creation", async () => {
    const { provider } = providerHarness();
    const create = vi.mocked(provider.create);
    let resolveCreate!: (value: SandboxLease) => void;
    create.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    const manager = new SandboxLeaseManager(createTenantId("tnt_a"), provider);
    const ownerContext = context();

    const pending = Array.from({ length: 12 }, () => manager.getOrCreate(ownerContext));
    expect(create).toHaveBeenCalledTimes(1);
    resolveCreate(lease("shared", create.mock.calls[0]![0].owner));
    const leases = await Promise.all(pending);

    expect(leases.every((item) => item === leases[0])).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("destroys a run lease when its abort signal fires", async () => {
    const { provider, destroy } = providerHarness();
    const manager = new SandboxLeaseManager(createTenantId("tnt_a"), provider);
    const abort = new AbortController();
    const ownerContext = context({ signal: abort.signal });
    const created = await manager.getOrCreate(ownerContext);

    abort.abort();

    await vi.waitFor(() => expect(destroy).toHaveBeenCalledWith(created));
  });

  it("closeAll destroys every cached lease and prevents new leases", async () => {
    const { provider, create, destroy } = providerHarness();
    const manager = new SandboxLeaseManager(createTenantId("tnt_a"), provider);
    const first = await manager.getOrCreate(context());
    const second = await manager.getOrCreate(context({ runId: "run-b" }));

    await manager.closeAll();

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(destroy.mock.calls.map(([item]) => item.id).sort()).toEqual([first.id, second.id].sort());
    await expect(manager.getOrCreate(context({ runId: "run-c" }))).rejects.toThrow("closed");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([
    "/etc/passwd",
    "C:\\Users\\other\\secret.txt",
    "\\\\server\\share\\secret.txt",
    "../secret.txt",
    "workspace/../../secret.txt",
    "safe/\0secret.txt",
  ])("rejects unsafe file path %j", (unsafePath) => {
    expect(() => resolveSandboxPath(unsafePath, { operation: "read" })).toThrow();
  });

  it("allows uploads reads but rejects uploads writes", () => {
    expect(resolveSandboxPath("uploads/report.csv", { operation: "read" })).toEqual({
      internalPath: "/input/uploads/report.csv",
      displayPath: "uploads/report.csv",
      space: "uploads",
      writable: false,
    });
    expect(() => resolveSandboxPath("uploads/report.csv", { operation: "write" }))
      .toThrow("只读空间");
    expect(() => resolveSandboxPath("report.csv", { explicitSpace: "uploads", operation: "write" }))
      .toThrow("只读空间");
  });

  it.each([
    ["workspace", "/work/report.txt"],
    ["transient", "/work/transient/report.txt"],
    ["exports", "/output/report.txt"],
  ] as const)("maps the %s space to its isolated sandbox root", (space, internalPath) => {
    expect(resolveSandboxPath("report.txt", { explicitSpace: space, operation: "write" })).toEqual({
      internalPath,
      displayPath: `${space}/report.txt`,
      space,
      writable: true,
    });
  });

  it.each([
    "../**/*",
    "workspace/../../*",
    "..\\*.txt",
    "safe/\0*.txt",
    "/etc/*",
    "C:\\Users\\*",
  ])("rejects glob patterns that can escape the sandbox: %j", (pattern) => {
    expect(() => validateSandboxGlob(pattern)).toThrow();
  });
});
