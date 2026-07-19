import { describe, expect, it, vi } from "vitest";
import { SaaSRuntimeRegistry, type SaaSTenantRuntimeHandle } from "../../src/app/composition/saas/saas-runtime-registry.js";

const handle = (tenantId: string, close = vi.fn()): SaaSTenantRuntimeHandle => ({
  tenantId: tenantId as SaaSTenantRuntimeHandle["tenantId"],
  conversation: {} as SaaSTenantRuntimeHandle["conversation"],
  runs: {} as SaaSTenantRuntimeHandle["runs"],
  close,
});

describe("SaaSRuntimeRegistry", () => {
  it("caches a tenant handle and releases leases idempotently", async () => {
    const create = vi.fn(async (tenantId: SaaSTenantRuntimeHandle["tenantId"]) => handle(tenantId));
    const registry = new SaaSRuntimeRegistry({ create });
    const first = await registry.acquire(" tenant-a ");
    const second = await registry.acquire("tenant-a");
    expect(create).toHaveBeenCalledTimes(1);
    expect(first.runtime).toBe(second.runtime);
    expect(registry.snapshot("tenant-a")).toEqual({ tenantId: "tenant-a", references: 2 });
    first.release(); first.release(); second.release();
    expect(registry.snapshot("tenant-a")?.references).toBe(0);
  });

  it("deduplicates concurrent tenant initialization", async () => {
    let resolve!: (value: SaaSTenantRuntimeHandle) => void;
    const pending = new Promise<SaaSTenantRuntimeHandle>((r) => { resolve = r; });
    const create = vi.fn(() => pending);
    const registry = new SaaSRuntimeRegistry({ create });
    const first = registry.acquire("tenant-a");
    const second = registry.acquire("tenant-a");
    resolve(handle("tenant-a"));
    const leases = await Promise.all([first, second]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(leases[0].runtime).toBe(leases[1].runtime);
  });

  it("closes tenant resources and rejects new leases after closeAll", async () => {
    const close = vi.fn();
    const registry = new SaaSRuntimeRegistry({ create: async (tenantId) => handle(tenantId, close) });
    await registry.acquire("tenant-a");
    await registry.closeTenant("tenant-a");
    expect(close).toHaveBeenCalledTimes(1);
    await expect(registry.acquire("tenant-a")).resolves.toBeTruthy();
    await registry.closeAll();
    await expect(registry.acquire("tenant-a")).rejects.toThrow("closed");
  });
});
