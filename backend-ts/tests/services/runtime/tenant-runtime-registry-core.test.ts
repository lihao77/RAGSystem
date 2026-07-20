import { describe, expect, it } from "vitest";

import { createUserId } from "../../../src/identity/types.js";
import { TenantRuntimeRegistryCore } from "../../../src/services/runtime/tenant-runtime-registry.js";

interface TestRuntime {
  sessions: Set<string>;
  running: number;
  closed: boolean;
}

describe("TenantRuntimeRegistryCore", () => {
  it("shares concurrent initialization without deployment-specific dependencies", async () => {
    let createCount = 0;
    const registry = createRegistry(() => {
      createCount += 1;
      return { sessions: new Set(), running: 0, closed: false };
    });

    const leases = await Promise.all(Array.from({ length: 4 }, () => registry.acquire("tnt_shared")));
    expect(createCount).toBe(1);
    expect(new Set(leases.map((lease) => lease.runtime)).size).toBe(1);
    expect(registry.snapshot("tnt_shared")).toMatchObject({ references: 4, state: "ready" });

    for (const lease of leases) lease.release();
    await registry.closeAll();
    expect(leases[0]?.runtime.closed).toBe(true);
  });

  it("finds sessions and owns daemon route tokens in the shared lifecycle layer", async () => {
    const registry = createRegistry(() => ({ sessions: new Set(["ses_target"]), running: 0, closed: false }));
    const initial = await registry.acquire("tnt_session");
    initial.release();

    const found = await registry.acquireForSession("ses_target");
    expect(found?.tenantId).toBe("tnt_session");
    found?.release();

    const botId = createUserId("usr_bot");
    registry.registerRouteToken(found!.tenantId, botId, "route-token");
    expect(registry.resolveRouteToken("route-token")).toEqual({ tenantId: "tnt_session", botId });
    await registry.closeAll();
  });

  it("releases the probe lease when async session lookup fails", async () => {
    const registry = new TenantRuntimeRegistryCore<TestRuntime>({
      get: async () => ({ id: "tnt_probe", status: "active" }),
      list: async () => [{ id: "tnt_probe", status: "active" }],
    } as never, {
      createRuntime: () => ({ sessions: new Set(), running: 0, closed: false }),
      hasSession: async () => { throw new Error("lookup failed"); },
      closeRuntime: (runtime) => { runtime.closed = true; },
    });

    await expect(registry.acquireForSession("ses_missing")).rejects.toThrow("lookup failed");
    expect(registry.snapshot("tnt_probe")).toMatchObject({ references: 0 });
    await registry.closeAll();
  });

  it("serializes runtime preparation across concurrent acquires", async () => {
    let active = 0;
    let maxActive = 0;
    const registry = new TenantRuntimeRegistryCore<TestRuntime>(undefined, {
      createRuntime: () => ({ sessions: new Set(), running: 0, closed: false }),
      prepareRuntime: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
      hasSession: () => false,
      closeRuntime: (runtime) => { runtime.closed = true; },
    });

    const leases = await Promise.all([registry.acquire("tnt_prepare"), registry.acquire("tnt_prepare")]);
    expect(maxActive).toBe(1);
    leases.forEach((lease) => lease.release());
    await registry.closeAll();
  });
});

function createRegistry(createRuntime: () => TestRuntime): TenantRuntimeRegistryCore<TestRuntime> {
  return new TenantRuntimeRegistryCore(undefined, {
    createRuntime,
    hasSession: (runtime, sessionId) => runtime.sessions.has(sessionId),
    getRunningCount: (runtime) => runtime.running,
    closeRuntime: (runtime) => {
      runtime.closed = true;
    },
  });
}
