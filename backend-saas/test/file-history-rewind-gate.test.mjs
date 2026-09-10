import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { POSTGRES_FILE_HISTORY_MIGRATIONS } from "../dist/adapters/saas/postgres/file-history-schema.js";
import { SaaSFileHistoryStorage } from "../dist/adapters/saas/object-storage/file-history-storage.js";

const TENANT = "tnt_test";
const KEY = `tenants/${TENANT}/ws/geomap_data.py`;

test("file history migration v2 adds a nullable tracked_seq gate column idempotently", () => {
  const v2 = POSTGRES_FILE_HISTORY_MIGRATIONS.find((m) => m.version === 2);
  assert.ok(v2, "migration v2 must exist");
  assert.equal(v2.name, "file_history_pending_tracked_seq");
  assert.match(v2.sql, /ALTER TABLE file_history_pending ADD COLUMN IF NOT EXISTS tracked_seq BIGINT/);
  assert.doesNotMatch(v2.sql, /NOT NULL/, "legacy rows must stay NULL (never flushed by rewind)");
  assert.doesNotMatch(v2.sql, /UPDATE/, "no data backfill");
});

/** 内存版元数据仓储：putPending 保留 ON CONFLICT DO NOTHING 语义（陈旧行挡新备份）。 */
function createFakeMetadata() {
  const pending = new Map();
  const snapshots = [];
  return {
    pending,
    snapshots,
    consumeCalls: [],
    async putPending(_tenantId, _sessionId, fileKey, tracked) {
      if (pending.has(fileKey)) return false;
      pending.set(fileKey, tracked);
      return true;
    },
    async getPending() {
      return Object.fromEntries(pending);
    },
    async commitSnapshot(_tenantId, _sessionId, snapshot) {
      if (pending.size === 0) return false;
      snapshot.tracked_files = Object.fromEntries(pending);
      pending.clear();
      snapshots.push(snapshot);
      return true;
    },
    async listSnapshots() {
      return snapshots;
    },
    async replaceSnapshots(_tenantId, _sessionId, next, consumePendingKeys = []) {
      this.consumeCalls.push([...consumePendingKeys]);
      snapshots.length = 0;
      snapshots.push(...next);
      for (const key of consumePendingKeys) pending.delete(key);
    },
    async cleanup() {
      pending.clear();
      snapshots.length = 0;
    },
  };
}

function createFakeObjects() {
  const blobs = new Map();
  return {
    blobs,
    async put(key, body, contentType = null) {
      blobs.set(key, { body, metadata: { contentType } });
      return { contentType };
    },
    async get(key) {
      return blobs.get(key) ?? null;
    },
    async head(key) {
      return blobs.has(key) ? { contentType: null } : null;
    },
    async delete(key) {
      return blobs.delete(key);
    },
  };
}

const asText = (body) => Buffer.from(body).toString("utf8");

function createHarness(maxSeq = null) {
  const metadata = createFakeMetadata();
  const objects = createFakeObjects();
  const storage = new SaaSFileHistoryStorage(
    TENANT,
    metadata,
    objects,
    maxSeq == null ? undefined : () => Promise.resolve(maxSeq),
  );
  return { storage, metadata, objects };
}

test("rewind keeps pending edits tracked before the anchor and consumes them atomically on revert", async () => {
  // 事故复刻：completed run 快照 @100；崩溃/停止 run 的编辑（tracked_seq=150）悬在 pending；
  // 无关锚点 200 的回退不得冲刷；更早锚点 120 回退时恢复对象并在同一次 replaceSnapshots 里消费。
  const { storage, metadata, objects } = createHarness(150);
  await objects.put(KEY, new TextEncoder().encode("v1\n"));
  await storage.trackEdit({ sessionId: "session-1", fileKey: KEY, original: new TextEncoder().encode("v1\n") });
  await objects.put(KEY, new TextEncoder().encode("v2-stopped-run\n"));

  const anchorAfter = await storage.rewind("session-1", 200);
  assert.equal(anchorAfter.reverted_files, 0);
  assert.equal(asText((await objects.get(KEY)).body), "v2-stopped-run\n");
  assert.ok(metadata.pending.has(KEY), "pending row must survive the unrelated anchor");

  const earlier = await storage.rewind("session-1", 120);
  assert.equal(earlier.reverted_files, 1);
  assert.equal(asText((await objects.get(KEY)).body), "v1\n");
  assert.equal(metadata.pending.size, 0, "consumed row must be deleted");
  assert.deepEqual(metadata.consumeCalls.at(-1), [KEY], "consumption rides the same replaceSnapshots call");
});

test("rewind reverts pending edits tracked at exactly the anchor seq and lets re-edits back up fresh content", async () => {
  const { storage, metadata, objects } = createHarness(7);
  await objects.put(KEY, new TextEncoder().encode("a\n"));
  await storage.trackEdit({ sessionId: "session-1", fileKey: KEY, original: new TextEncoder().encode("a\n") });
  await objects.put(KEY, new TextEncoder().encode("b\n"));

  const atAnchor = await storage.rewind("session-1", 7);
  assert.equal(atAnchor.reverted_files, 1);
  assert.equal(asText((await objects.get(KEY)).body), "a\n");
  assert.equal(metadata.pending.size, 0);

  // 消费后重编辑：新备份基于当前内容，不被陈旧行（ON CONFLICT DO NOTHING）挡住
  await storage.trackEdit({ sessionId: "session-1", fileKey: KEY, original: new TextEncoder().encode("a2\n") });
  const reTracked = metadata.pending.get(KEY);
  assert.equal(reTracked.tracked_seq, 7);
  assert.match(reTracked.backup_hash, /^[a-f0-9]{64}$/);
});

test("legacy pending rows without tracked_seq are never flushed by rewind", async () => {
  const { storage, metadata, objects } = createHarness(999);
  const legacyHash = crypto.createHash("sha256").update("original\n", "utf8").digest("hex");
  metadata.pending.set(KEY, { action: "modified", backup_hash: legacyHash, content_type: null, tracked_seq: null });
  await objects.put(`tenants/${TENANT}/file-history/session-1/backups/${legacyHash}`, new TextEncoder().encode("original\n"));
  await objects.put(KEY, new TextEncoder().encode("edited-by-crashed-run\n"));

  const result = await storage.rewind("session-1", 999);
  assert.equal(result.reverted_files, 0);
  assert.equal(asText((await objects.get(KEY)).body), "edited-by-crashed-run\n");
  assert.ok(metadata.pending.has(KEY), "legacy row survives for the next snapshot boundary");
});
