import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  PgPoolMemoryExecutor,
  PostgresMemoryImporter,
  runPostgresMemoryMigrations,
} from "../../src/adapters/saas/postgres/index.js";
import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { scanFilesystemMemory } from "../../src/services/memory-import/filesystem-memory-scanner.js";
import { createSaaSMemoryRuntime } from "../../src/services/runtime/saas-memory-runtime.js";
import { makeTempRoot } from "../helpers/temp-db.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const tenantIds: string[] = [];
const pool = databaseUrl == null ? null : new Pool({ connectionString: databaseUrl, max: 2 });

afterAll(async () => {
  if (pool == null) return;
  if (tenantIds.length > 0) {
    await pool.query("DELETE FROM memory_candidates WHERE tenant_id = ANY($1::text[])", [tenantIds]);
    await pool.query("DELETE FROM memory_scope_revisions WHERE tenant_id = ANY($1::text[])", [tenantIds]);
    await pool.query("DELETE FROM memory_entries WHERE tenant_id = ANY($1::text[])", [tenantIds]);
  }
  await pool.end();
});

describe.skipIf(databaseUrl == null)("PostgreSQL Memory E2E", () => {
  it("migrates, publishes, isolates tenants, and survives runtime recreation", async () => {
    if (databaseUrl == null || pool == null) throw new Error("DATABASE_URL is required");

    const suffix = randomUUID().replaceAll("-", "");
    const tenantA = `tnt_memory_e2e_a_${suffix}`;
    const tenantB = `tnt_memory_e2e_b_${suffix}`;
    tenantIds.push(tenantA, tenantB);

    const firstRuntime = await createSaaSMemoryRuntime({
      connectionString: databaseUrl,
      pool,
    });
    const memoryA = firstRuntime.provider.memoryForTenant(tenantA);
    const memoryB = firstRuntime.provider.memoryForTenant(tenantB);
    let sessionMetadata: Record<string, unknown> = {};
    const sessions = {
      getSession: () => ({ metadata: sessionMetadata, user_id: "usr_e2e" }),
      updateSessionMetadata: (_sessionId: string, patch: Record<string, unknown>) => {
        sessionMetadata = { ...sessionMetadata, ...patch };
        return sessionMetadata;
      },
    };
    const tools = firstRuntime.provider.createMemoryBindings(tenantA, sessions).tools;
    const agent = {
      agent_name: "assistant",
      memory: {
        auto_inject: true,
        allowed_scopes: ["session"],
        write_scopes: ["session"],
        archive_scopes: ["session"],
      },
    } as AgentConfig;
    const written = await tools.writeMemory({
      scope: "session",
      name: "E2E policy",
      description: "Policy written through the tenant Memory application",
      memoryType: "fact",
      content: "Use PostgreSQL for SaaS memory.",
      sourceRunId: "run-e2e",
    }, {
      agent,
      sessionId: "session-e2e",
      userId: "usr_e2e",
      runId: "run-e2e",
    });
    expect(written.success).toBe(true);
    expect(written.content).toMatchObject({ published: true });
    const writtenContent = written.content as Record<string, unknown>;
    const candidateId = String(writtenContent.candidate_id);
    const memoryId = String(writtenContent.memory_id);
    const candidate = await memoryA.governance.getCandidate(candidateId);
    if (!candidate) throw new Error("memory candidate was not written by the tool");
    expect(candidate).toMatchObject({
      status: "approved",
      published_memory_id: memoryId,
    });

    await expect(memoryB.governance.getCandidate(candidate.id)).resolves.toBeNull();
    await expect(memoryB.governance.approveCandidate({
      candidate_id: candidate.id,
      reviewer_user_id: "reviewer-1",
      expected_version: candidate.version,
    })).resolves.toEqual({ outcome: "not_found" });

    const published = await memoryA.query.getEntry(memoryId);
    expect(published).toMatchObject({
      tenant_id: tenantA,
      status: "active",
      content: "Use PostgreSQL for SaaS memory.",
    });
    await expect(memoryB.query.listEntries({ scope: "session", scope_id: "session-e2e" }))
      .resolves.toEqual([]);

    const context = firstRuntime.provider.createMemoryBindings(tenantA, sessions).createContextSource({
      sessions,
      memory: agent.memory,
      agentName: agent.agent_name,
      memoryConfig: { index_max_lines: 100, index_max_chars: 4096 },
      dataRoot: "unused-in-saas",
    });
    const contribution = await context.build({
      sessionId: "session-e2e",
      threadKey: "root",
      microcompact: false,
      microcompactKeepRecentTools: 5,
      cacheAlive: false,
      touch: false,
    });
    expect(contribution.conversation?.[0]?.content).toContain("E2E policy");
    expect(contribution.conversation?.[0]?.content).toContain(memoryId);

    await firstRuntime.close();

    // Recreating the runtime reruns migrations and proves both migration
    // idempotence and persistence across runtime lifetimes.
    const secondRuntime = await createSaaSMemoryRuntime({
      connectionString: databaseUrl,
      pool,
    });
    const restartedMemory = secondRuntime.provider.memoryForTenant(tenantA);
    await expect(restartedMemory.query.getEntry(memoryId)).resolves.toMatchObject({
      id: memoryId,
      tenant_id: tenantA,
      content: "Use PostgreSQL for SaaS memory.",
    });
    await expect(restartedMemory.query.getScopeRevision({ scope: "session", scope_id: "session-e2e" }))
      .resolves.toBe(1);
    await secondRuntime.close();
  }, 30_000);

  it("imports a custom filesystem dataRoot and reruns idempotently", async () => {
    if (databaseUrl == null || pool == null) throw new Error("DATABASE_URL is required");
    const tenantId = `tnt_memory_import_${randomUUID().replaceAll("-", "")}`;
    tenantIds.push(tenantId);
    const root = makeTempRoot();
    const entryPath = path.join(root, "memory", "sessions", "session-import", "fact_imported.md");
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, [
      "---",
      "name: Imported E2E memory",
      "description: Imported from a custom dataRoot",
      "type: session",
      "memory_type: fact",
      "status: active",
      "created_at: 2026-01-01T00:00:00Z",
      "updated_at: 2026-01-02T00:00:00Z",
      "source_run_id: run-import",
      "source_message_id: msg-import",
      "---",
      "",
      "Imported body.",
      "",
      "**Why:** Migration E2E.",
      "**How to apply:** Verify the importer.",
      "",
    ].join("\n"), "utf8");

    const scan = scanFilesystemMemory(root, tenantId);
    expect(scan.issues).toEqual([]);
    const executor = new PgPoolMemoryExecutor(pool);
    await runPostgresMemoryMigrations(executor);
    const importer = new PostgresMemoryImporter(executor);
    await expect(importer.importEntries(tenantId, scan.entries)).resolves.toMatchObject({
      imported: 1,
      verified: 1,
    });
    await expect(importer.importEntries(tenantId, scan.entries)).resolves.toMatchObject({
      imported: 0,
      skipped_identical: 1,
      verified: 1,
    });

    const runtime = await createSaaSMemoryRuntime({ connectionString: databaseUrl, pool });
    await expect(runtime.provider.memoryForTenant(tenantId).query.getEntry(scan.entries[0]!.id))
      .resolves.toMatchObject({
        name: "Imported E2E memory",
        content: "Imported body.",
        why: "Migration E2E.",
        how_to_apply: "Verify the importer.",
        source_run_id: "run-import",
      });
    await runtime.close();
  }, 30_000);
});
