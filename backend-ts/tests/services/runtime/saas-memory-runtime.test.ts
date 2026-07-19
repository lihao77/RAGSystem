import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn<() => Promise<void>>(),
  };
  const Pool = vi.fn(function MockPool() { return pool; });
  return { pool, Pool };
});

vi.mock("pg", () => ({ Pool: pg.Pool }));

import { createSaaSMemoryRuntime } from "../../../src/adapters/saas/composition/saas-memory-runtime.js";

describe("createSaaSMemoryRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.pool.end.mockResolvedValue(undefined);
  });

  it("composes a tenant provider over an injected shared pool", async () => {
    const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const handle = await createSaaSMemoryRuntime({
      connectionString: "postgres://example/ragsystem",
      pool: pool as never,
      runMigrations: false,
    });

    const memory = handle.provider.memoryForTenant("tnt_alpha");
    expect(memory).toEqual(expect.objectContaining({ query: expect.anything(), governance: expect.anything() }));
    await handle.close();
    await handle.close();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("rejects an empty connection string before using the pool", async () => {
    await expect(createSaaSMemoryRuntime({ connectionString: " " })).rejects.toThrow("connection string");
  });

  it("shares one close promise and waits for the owned pool to end", async () => {
    let finishPoolEnd!: () => void;
    pg.pool.end.mockImplementation(() => new Promise<void>((resolve) => {
      finishPoolEnd = resolve;
    }));
    const handle = await createSaaSMemoryRuntime({
      connectionString: "postgres://example/ragsystem",
      runMigrations: false,
    });

    const first = handle.close();
    const second = handle.close();
    let settled = false;
    void first.finally(() => { settled = true; });
    await Promise.resolve();

    expect(first).toBe(second);
    expect(pg.pool.end).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finishPoolEnd();
    await expect(first).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("propagates an owned pool close failure to every concurrent caller", async () => {
    const failure = new Error("pool shutdown failed");
    pg.pool.end.mockRejectedValue(failure);
    const handle = await createSaaSMemoryRuntime({
      connectionString: "postgres://example/ragsystem",
      runMigrations: false,
    });

    const first = handle.close();
    const second = handle.close();

    expect(first).toBe(second);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(pg.pool.end).toHaveBeenCalledOnce();
    expect(handle.close()).toBe(first);
  });
});
