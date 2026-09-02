import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "../dist/adapters/local/sqlite/conversation-store/migrations.js";
import { BASELINE_SCHEMA_SQL } from "../dist/adapters/local/sqlite/conversation-store/schema.js";
import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";

const agents = { orchestrator_agent: { agent_name: "orchestrator_agent" } };
const teamSnapshot = { team_name: "test", team_revision: computeSessionTeamRevision(agents), entry_agent_name: "orchestrator_agent", agents };

function createStore() {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  store.createSession({
    tenantId: "tnt_test",
    sessionId: "session-feedback",
    ownerUserId: "usr_test",
    visibility: "private",
    originType: "direct",
    originId: null,
    originChannel: "web",
    workspaceId: null,
    teamSnapshot,
    metadata: {},
    permissionMode: null,
  });
  return store;
}

test("message feedback upserts, overwrites, lists, and clears per message", () => {
  const store = createStore();
  try {
    const first = store.setMessageFeedback({
      sessionId: "session-feedback",
      messageId: "message-a",
      tenantId: "tnt_test",
      value: "up",
    });
    assert.equal(first.value, "up");
    assert.equal(first.comment, null);

    // 同消息改评：覆盖 up→down，created_at 保留首次时间
    const overwritten = store.setMessageFeedback({
      sessionId: "session-feedback",
      messageId: "message-a",
      tenantId: "tnt_test",
      value: "down",
      comment: "答非所问",
    });
    assert.equal(overwritten.value, "down");
    assert.equal(overwritten.comment, "答非所问");
    assert.equal(overwritten.created_at, first.created_at);

    store.setMessageFeedback({
      sessionId: "session-feedback",
      messageId: "message-b",
      tenantId: "tnt_test",
      value: "down",
    });

    const listed = store.listMessageFeedback("session-feedback");
    assert.equal(listed.length, 2);
    assert.ok(listed.every(item => item.session_id === "session-feedback" && item.tenant_id === "tnt_test"));

    // 被踩清单：只含 down，按 updated_at 倒序
    const negative = store.listNegativeMessageFeedback("tnt_test");
    assert.deepEqual(negative.map(item => item.message_id).sort(), ["message-a", "message-b"]);

    assert.equal(store.clearMessageFeedback("session-feedback", "message-a"), true);
    assert.equal(store.clearMessageFeedback("session-feedback", "message-a"), false);
    assert.equal(store.listMessageFeedback("session-feedback").length, 1);
    assert.deepEqual(
      store.listNegativeMessageFeedback("tnt_test").map(item => item.message_id),
      ["message-b"],
    );
  } finally {
    store.close();
  }
});

test("negative feedback list honors since and limit filters", () => {
  const store = createStore();
  try {
    for (const id of ["m1", "m2", "m3"]) {
      store.setMessageFeedback({ sessionId: "session-feedback", messageId: id, tenantId: "tnt_test", value: "down" });
    }
    assert.equal(store.listNegativeMessageFeedback("tnt_test", { limit: 2 }).length, 2);
    // since 取未来时间 → 全部排除；租户外无泄漏
    assert.equal(store.listNegativeMessageFeedback("tnt_test", { since: new Date(Date.now() + 60_000).toISOString() }).length, 0);
    assert.equal(store.listNegativeMessageFeedback("tnt_other").length, 0);
  } finally {
    store.close();
  }
});

test("v22 conversation database upgrades to v23 with message_feedback", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BASELINE_SCHEMA_SQL);
    db.exec(`
      DROP INDEX IF EXISTS idx_message_feedback_session;
      DROP INDEX IF EXISTS idx_message_feedback_tenant_value_updated;
      DROP TABLE IF EXISTS message_feedback;
    `);
    db.exec("PRAGMA user_version = 22");
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_feedback'").get(),
      undefined,
    );
    db.prepare(`
      INSERT INTO sessions (session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel, team_snapshot)
      VALUES ('session-feedback', 'tnt_test', 'usr_test', 'private', 'direct', 'web', '{}')
    `).run();

    runMigrations(db);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_feedback'").get());
    // value CHECK 约束随表重建生效
    db.prepare(`
      INSERT INTO message_feedback (message_id, session_id, tenant_id, value, created_at, updated_at)
      VALUES ('m', 'session-feedback', 'tnt_test', 'up', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();
    assert.throws(() =>
      db.prepare(`
        INSERT INTO message_feedback (message_id, session_id, tenant_id, value, created_at, updated_at)
        VALUES ('m2', 'session-feedback', 'tnt_test', 'meh', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `).run(),
    );
  } finally {
    db.close();
  }
});
