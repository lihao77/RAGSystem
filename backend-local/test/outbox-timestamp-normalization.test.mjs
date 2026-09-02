import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createTenantId } from "@ragsystem/backend-core/identity/types.js";
import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";
import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "../dist/adapters/local/sqlite/conversation-store/migrations.js";
import { BASELINE_SCHEMA_SQL } from "../dist/adapters/local/sqlite/conversation-store/schema.js";

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const tenantId = createTenantId("tnt_test");
const agents = { root: { agent_name: "root" } };
const teamSnapshot = { team_name: "test", team_revision: computeSessionTeamRevision(agents), entry_agent_name: "root", agents };

function seedSession(store, sessionId = "session-1") {
  store.createSession({
    tenantId,
    sessionId,
    ownerUserId: "usr_test",
    visibility: "private",
    originType: "direct",
    originId: null,
    originChannel: "web",
    workspaceId: null,
    teamSnapshot,
    metadata: {},
  });
}

function appendClientEvent(store, eventId) {
  return store.appendOutbox({
    sessionId: "session-1",
    runId: null,
    eventId,
    eventType: "client.tool_call",
    aggregateType: "run",
    aggregateId: "session-1",
    payload: { client_event: { type: "tool_call" } },
  });
}

test("v24 migration backfills event_outbox timestamps to ISO-Z, idempotently", () => {
  // node:sqlite 默认开 FK；本夹具只带 outbox 行（时间戳形状与引用完整性无关），连接级关闭。
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  try {
    db.exec(BASELINE_SCHEMA_SQL);
    db.exec("PRAGMA user_version = 23");
    const insert = db.prepare(`
      INSERT INTO event_outbox (event_id, session_id, tenant_id, run_id, session_seq, event_type,
        aggregate_type, aggregate_id, payload, status, available_at, created_at)
      VALUES (?, ?, ?, NULL, ?, 'client.tool_call', 'run', 'session-1', '{}', 'pending', ?, ?)
    `);
    // 历史形状混合：无 Z 文本（CURRENT_TIMESTAMP 产物）与已带 Z 的行共存。
    insert.run("evt-a", "session-1", "tnt_test", 1, "2024-01-02 03:04:05", "2024-01-02 03:04:05");
    insert.run("evt-b", "session-1", "tnt_test", 2, "2024-01-02T05:00:00.000Z", "2024-01-02T05:00:00.000Z");
    insert.run("evt-c", "session-1", "tnt_test", 3, "2024-01-02T06:00:00.000Z", "2024-01-02 06:00:01");
    insert.run("evt-d", "session-1", "tnt_test", 4, "2024-01-02 07:00:00", "not-a-timestamp");

    runMigrations(db);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
    const rows = db.prepare("SELECT event_id, available_at, created_at FROM event_outbox ORDER BY id").all();
    assert.equal(rows[0].created_at, "2024-01-02T03:04:05.000Z");
    assert.equal(rows[0].available_at, "2024-01-02T03:04:05.000Z");
    assert.equal(rows[1].created_at, "2024-01-02T05:00:00.000Z", "已带 Z 的行保持字节不变");
    assert.equal(rows[1].available_at, "2024-01-02T05:00:00.000Z");
    assert.equal(rows[2].created_at, "2024-01-02T06:00:01.000Z");
    assert.equal(rows[2].available_at, "2024-01-02T06:00:00.000Z", "仅归一无 Z 的列，不动已规范的列");
    assert.equal(rows[3].created_at, "not-a-timestamp", "不可解析的坏形状保持原样可见，不得被静默置 NULL");
    assert.equal(rows[3].available_at, "2024-01-02T07:00:00.000Z", "同行另一列正常归一");

    // 幂等：伪装回 v23 再跑一遍，值不再变化。
    db.exec("PRAGMA user_version = 23");
    runMigrations(db);
    const rerun = db.prepare("SELECT event_id, created_at FROM event_outbox ORDER BY id").all();
    assert.deepEqual(rerun.map((row) => row.created_at), [
      "2024-01-02T03:04:05.000Z",
      "2024-01-02T05:00:00.000Z",
      "2024-01-02T06:00:01.000Z",
      "not-a-timestamp",
    ]);
  } finally {
    db.close();
  }
});

test("outbox read exits return ISO-Z created_at for live writes", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    seedSession(store);
    const appended = appendClientEvent(store, "evt-1");
    assert.match(appended.created_at, ISO_Z, "appendOutbox 返回值必须带 Z");
    assert.match(store.getOutboxRow(appended.id).created_at, ISO_Z);
    for (const row of store.fetchPendingOutbox()) assert.match(row.created_at, ISO_Z);
    for (const row of store.claimPendingOutbox({ lockTimeoutMs: 60_000 })) assert.match(row.created_at, ISO_Z);
    for (const row of store.listOutboxForReplay({ sessionId: "session-1" })) assert.match(row.created_at, ISO_Z);
    for (const row of store.listOutbox({}).items) assert.match(row.created_at, ISO_Z);

    store.markOutboxFailed(appended.id, "boom");
    const stats = store.getOutboxStats();
    assert.match(stats.oldest_failed_created_at, ISO_Z);
    assert.equal(stats.oldest_pending_or_retrying_created_at, null, "仅剩 failed 行时 pending 口径为空");
    assert.match(stats.recent_failed_errors[0].created_at, ISO_Z);
  } finally {
    store.close();
  }
});

test("GC no longer treats recent undelivered-timestamp rows as older than an ISO-Z cutoff", () => {
  // 历史 bug：created_at 无 Z（"2026-09-02 09:00:00"）与 ISO-Z cutoff（"2026-09-02T08:00…"）
  // 逐字符比较时 ' ' < 'T'，同日即误判为更老，delivered_at 缺失的行会被提前 GC。
  // 注意分两个阶段：读出口归一不改变 SQL 谓词看到的原始列值，GC 正确性依赖迁移后的同构列。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-outbox-"));
  const dbPath = path.join(dir, "conv.db");
  try {
    const store = createConversationStore({ dbPath, dataRoot: process.cwd() });
    seedSession(store);
    const row = appendClientEvent(store, "evt-gc");
    store.markOutboxDelivered(row.id);
    store.close();

    // 阶段一：模拟半迁移/手工编辑——列值改回无 Z 文本，读出口（含幂等重放）必须收敛。
    let raw = new DatabaseSync(dbPath);
    raw.exec(`UPDATE event_outbox SET delivered_at=NULL, created_at='2024-01-02 03:04:05' WHERE id=${row.id}`);
    raw.close();
    let reopened = createConversationStore({ dbPath, dataRoot: process.cwd() });
    try {
      assert.equal(reopened.getOutboxRow(row.id).created_at, "2024-01-02T03:04:05.000Z");
      const replayed = appendClientEvent(reopened, "evt-gc");
      assert.equal(replayed.created_at, "2024-01-02T03:04:05.000Z");
    } finally {
      reopened.close();
    }

    // 阶段二：恢复迁移后的规范列值（delivered_at 仍缺失），GC 不得把比 cutoff 新的行清掉。
    raw = new DatabaseSync(dbPath);
    raw.exec(`UPDATE event_outbox SET created_at='${row.created_at}' WHERE id=${row.id}`);
    raw.close();
    reopened = createConversationStore({ dbPath, dataRoot: process.cwd() });
    try {
      const before = new Date(new Date(row.created_at).getTime() - 3_600_000).toISOString();
      const deleted = reopened.deleteDeliveredOutbox({ before, limit: 100 });
      assert.equal(deleted, 0, "比 cutoff 新的行不得被 GC");
      assert.ok(reopened.getOutboxRow(row.id), "行必须仍在");
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
