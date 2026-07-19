import { describe, expect, it, vi } from "vitest";
import { PostgresDaemonLeaderLease } from "../../src/adapters/saas/postgres/daemon-leader-lease.js";

describe("PostgresDaemonLeaderLease", () => {
  it("holds the client for the leader lifetime and releases the advisory lock", async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] }), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const lease = new PostgresDaemonLeaderLease(pool as never);
    await expect(lease.acquire()).resolves.toBe(true);
    expect(pool.connect).toHaveBeenCalledOnce();
    await lease.release();
    expect(client.query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock($1)", [0x52414744]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("releases a non-leader connection immediately", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ locked: false }] }), release: vi.fn() };
    const lease = new PostgresDaemonLeaderLease({ connect: vi.fn().mockResolvedValue(client) } as never);
    await expect(lease.acquire()).resolves.toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
