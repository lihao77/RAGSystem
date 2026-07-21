import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe } from "vitest";

import { PgPoolMemoryExecutor } from "../../../../src/adapters/saas/postgres/memory-executor.js";
import { PostgresOutboxRepository } from "../../../../src/adapters/saas/postgres/outbox-repository.js";
import { PostgresRuntimeStorage } from "../../../../src/adapters/saas/postgres/postgres-runtime-storage.js";
import { runPostgresConversationMigrations } from "../../../../src/adapters/saas/postgres/conversation-migrations.js";
import { runPostgresOutboxMigrations } from "../../../../src/adapters/saas/postgres/outbox-migrations.js";
import { runPostgresRunMigrations } from "../../../../src/adapters/saas/postgres/run-migrations.js";
import type { OutboxRow, RunInfo } from "../../../../src/contracts/conversation-store/index.js";
import type { MessageInfo, SessionInfo } from "../../../../src/contracts/session/session.js";
import { createTenantId } from "../../../../src/identity/types.js";
import { runRuntimeStorageBehaviorContract } from "../../../contracts/runtime-storage-behavior-contract.js";

const databaseUrl = process.env.RUNTIME_STORAGE_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim();
const postgresEnabled = Boolean(databaseUrl);
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;
const schemas: string[] = [];

afterAll(async () => {
  if (!adminPool) return;
  for (const schema of schemas) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
  await adminPool.end();
});

describe.skipIf(!postgresEnabled)("PostgreSQL RuntimeStorage contract", () => {
  runRuntimeStorageBehaviorContract("PostgreSQL", async () => {
    if (!databaseUrl || !adminPool) throw new Error("DATABASE_URL is required");
    const schema = `runtime_contract_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-csearch_path=${schema},public`);
    const pool = new Pool({ connectionString: url.toString(), max: 4 });
    const executor = new PgPoolMemoryExecutor(pool);
    await runPostgresConversationMigrations(executor);
    await runPostgresRunMigrations(executor);
    await runPostgresOutboxMigrations(executor);

    const tenantId = createTenantId("tnt_runtime_contract");
    const storage = new PostgresRuntimeStorage(tenantId, executor);
    const outbox = new PostgresOutboxRepository(executor);
    return {
      storage,
      peerStorage: new PostgresRuntimeStorage(tenantId, executor),
      inspection: {
        getSession: async (sessionId: string) => first<SessionInfo>(pool, "SELECT * FROM conversation_sessions WHERE session_id=$1", [sessionId]),
        getMessage: async (sessionId: string, messageId: string) => normalizeMessage(await first<MessageInfo & { seq: number | string }>(pool, "SELECT * FROM conversation_messages WHERE session_id=$1 AND id=$2", [sessionId, messageId])),
        listMessages: async (sessionId: string) => (await rows<MessageInfo & { seq: number | string }>(pool, "SELECT * FROM conversation_messages WHERE session_id=$1 ORDER BY seq", [sessionId])).map((message) => normalizeMessage(message)!),
        getRun: async (sessionId: string, runId: string) => first<RunInfo>(pool, "SELECT * FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3", [tenantId, sessionId, runId]),
        listRuns: async (sessionId: string) => rows<RunInfo>(pool, "SELECT * FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at,run_id", [tenantId, sessionId]),
        listSteps: async (sessionId: string, runId: string) => rows<{ event_id: string | null; step_order: number }>(pool, "SELECT event_id,step_order FROM saas_run_steps WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 ORDER BY step_order", [tenantId, sessionId, runId]),
        listOutbox: async (sessionId: string) => outbox.listOutboxForReplay({ tenantId, sessionId, limit: 100 }),
      },
      outbox: {
        claimPending: (limit: number, now?: Date) => outbox.claimPendingOutbox({
          tenantId,
          limit,
          ...(now ? { now } : {}),
        }),
        markDelivered: (id: number) => outbox.markOutboxDelivered(id, tenantId),
      },
      close: async () => {
        await pool.end();
      },
    };
  });
});

async function rows<Row>(
  pool: Pool,
  sql: string,
  params: readonly unknown[],
): Promise<Row[]> {
  return (await pool.query(sql, [...params])).rows as unknown as Row[];
}

async function first<Row>(
  pool: Pool,
  sql: string,
  params: readonly unknown[],
): Promise<Row | null> {
  return (await rows<Row>(pool, sql, params))[0] ?? null;
}

function normalizeMessage(
  message: (MessageInfo & { seq: number | string }) | null,
): MessageInfo | null {
  return message ? { ...message, seq: Number(message.seq) } : null;
}
