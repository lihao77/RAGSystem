import { describe, expect, it, vi } from "vitest";

import { createSaaSMemoryRuntime } from "../../../src/services/runtime/saas-memory-runtime.js";

describe("createSaaSMemoryRuntime", () => {
  it("composes a tenant provider over an injected shared pool", async () => {
    const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const handle = await createSaaSMemoryRuntime({
      connectionString: "postgres://example/ragsystem",
      pool: pool as never,
      runMigrations: false,
    });

    const lease = await handle.provider.acquire("tnt_alpha");
    expect(lease.runtime.tenantId).toBe("tnt_alpha");
    expect(lease.runtime.memory).toEqual(expect.objectContaining({ query: expect.anything(), governance: expect.anything() }));
    lease.release();
    await handle.close();
    await handle.close();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("rejects an empty connection string before using the pool", async () => {
    await expect(createSaaSMemoryRuntime({ connectionString: " " })).rejects.toThrow("connection string");
  });
});
