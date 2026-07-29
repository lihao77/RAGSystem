import type { Pool, PoolClient } from "pg";

const DAEMON_LEADER_LOCK_ID = 0x52414744;

/** PostgreSQL session advisory lock. The client remains checked out while leader. */
export class PostgresDaemonLeaderLease {
  private client: PoolClient | null = null;
  constructor(private readonly pool: Pool) {}
  async acquire(): Promise<boolean> {
    if (this.client) return true;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [DAEMON_LEADER_LOCK_ID]);
      if (!result.rows[0]?.locked) { client.release(); return false; }
      this.client = client;
      return true;
    } catch (error) { client.release(); throw error; }
  }
  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try { await client.query("SELECT pg_advisory_unlock($1)", [DAEMON_LEADER_LOCK_ID]); }
    finally { client.release(); }
  }
}
