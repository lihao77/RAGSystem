import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "../dist/adapters/local/sqlite/conversation-store/migrations.js";
import { BASELINE_SCHEMA_SQL } from "../dist/adapters/local/sqlite/conversation-store/schema.js";
import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";

const agents = { orchestrator_agent: { agent_name: "orchestrator_agent" } };
const teamSnapshot = { team_name: "test", team_revision: computeSessionTeamRevision(agents), entry_agent_name: "orchestrator_agent", agents };

const withoutTitleOverride = sql => sql.replace("      title_override TEXT,\n", "");

function createStore(sessionId = "session-title") {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  store.createSession({
    tenantId: "tnt_test",
    sessionId,
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

test("v24 database gains session_list_projection.title_override (v25), idempotently", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutTitleOverride(BASELINE_SCHEMA_SQL));
    db.exec("PRAGMA user_version = 24");

    runMigrations(db);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
    const columns = db.prepare("PRAGMA table_info(session_list_projection)").all();
    assert.ok(columns.some(column => column.name === "title_override"));

    // 已是最新版本时重复执行只做断言，不改形状
    runMigrations(db);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("fresh baseline already carries title_override and current-schema assertion accepts it", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runMigrations(db);
    const columns = db.prepare("PRAGMA table_info(session_list_projection)").all();
    assert.ok(columns.some(column => column.name === "title_override"));
  } finally {
    db.close();
  }
});

test("title derives from first visible message; override wins and survives inserts and rebuilds", () => {
  const store = createStore();
  try {
    const longFirst = `${"这是一条特别长的首条消息，超过三十个字符的部分会被截断掉。"}${"尾巴".repeat(10)}`;
    store.addMessage({ sessionId: "session-title", role: "user", contentParts: [{ type: "text", text: longFirst }] });
    let entry = store.getSessionListProjection("session-title");
    assert.equal(entry.title, longFirst.trim().slice(0, 30));
    assert.equal(entry.title.length, 30);
    assert.equal(entry.first_message, longFirst);

    // LLM 标题回写：override 与展示 title 同步落
    assert.equal(store.updateSessionListTitle("session-title", "长消息标题"), true);
    entry = store.getSessionListProjection("session-title");
    assert.equal(entry.title, "长消息标题");

    // 后续消息插入不冲掉 override
    store.addMessage({ sessionId: "session-title", role: "assistant", contentParts: [{ type: "text", text: "好的" }] });
    entry = store.getSessionListProjection("session-title");
    assert.equal(entry.title, "长消息标题");

    // 重建投影（消息编辑路径）同样保留 override
    store.rebuildSessionListProjection("session-title");
    entry = store.getSessionListProjection("session-title");
    assert.equal(entry.title, "长消息标题");
    assert.equal(entry.first_message, longFirst);
  } finally {
    store.close();
  }
});

test("updateSessionListTitle skips sessions without a visible user message", () => {
  const store = createStore("session-guard");
  try {
    store.addMessage({ sessionId: "session-guard", role: "assistant", contentParts: [{ type: "text", text: "欢迎" }] });
    assert.equal(store.updateSessionListTitle("session-guard", "不应写入"), false);
    assert.equal(store.getSessionListProjection("session-guard").title, "欢迎");
  } finally {
    store.close();
  }
});

test("notifier fires exactly on the first visible user message", () => {
  const store = createStore("session-notify");
  try {
    const notified = [];
    store.setFirstVisibleUserMessageNotifier((sessionId, text) => notified.push([sessionId, text]));

    // 首条是 assistant 可见消息：不触发（标题由用户意图驱动）
    store.addMessage({ sessionId: "session-notify", role: "assistant", contentParts: [{ type: "text", text: "欢迎" }] });
    assert.deepEqual(notified, []);

    // 首条可见 user 消息：触发，携带纯文本
    store.addMessage({ sessionId: "session-notify", role: "user", contentParts: [{ type: "text", text: "帮我修复登录超时" }] });
    assert.deepEqual(notified, [["session-notify", "帮我修复登录超时"]]);

    // 第二条 user 消息与不可见消息：均不再触发
    store.addMessage({ sessionId: "session-notify", role: "user", contentParts: [{ type: "text", text: "再看看" }] });
    store.addMessage({ sessionId: "session-notify", role: "user", contentParts: [{ type: "text", text: "隐藏" }], metadata: { visible_to_user: false } });
    assert.equal(notified.length, 1);
  } finally {
    store.close();
  }
});

test("notifier contract violation (synchronous throw) does not break message persistence", () => {
  const store = createStore("session-throw");
  try {
    store.setFirstVisibleUserMessageNotifier(() => {
      throw new Error("notifier must not break the insert transaction");
    });
    const message = store.addMessage({ sessionId: "session-throw", role: "user", contentParts: [{ type: "text", text: "第一条" }] });
    assert.equal(message.role, "user");
    assert.equal(store.getSessionListProjection("session-throw").first_message, "第一条");
  } finally {
    store.close();
  }
});

test("rollback-to-empty then new first user message re-triggers title generation slot", () => {
  const store = createStore("session-rollback");
  try {
    const notified = [];
    store.setFirstVisibleUserMessageNotifier((sessionId) => notified.push(sessionId));

    store.addMessage({ sessionId: "session-rollback", role: "user", contentParts: [{ type: "text", text: "第一次提问" }] });
    store.updateSessionListTitle("session-rollback", "旧标题");
    assert.deepEqual(notified, ["session-rollback"]);

    // 回滚清空消息后 override 仍在（投影不因 rebuild 冲掉），新的首条 user 消息可再次触发生成
    store.deleteMessagesAfter("session-rollback", { afterSeq: 0 });
    assert.equal(store.getSessionListProjection("session-rollback").title, "旧标题");

    store.addMessage({ sessionId: "session-rollback", role: "user", contentParts: [{ type: "text", text: "第二次提问" }] });
    assert.deepEqual(notified, ["session-rollback", "session-rollback"]);
  } finally {
    store.close();
  }
});
