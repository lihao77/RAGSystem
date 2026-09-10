import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";

const agents = { orchestrator_agent: { agent_name: "orchestrator_agent" } };
const teamSnapshot = {
  team_name: "default",
  team_revision: computeSessionTeamRevision(agents),
  entry_agent_name: "orchestrator_agent",
  agents,
};

const SESSION_ID = "legacy-feishu-session";
const CREATE_INPUT = {
  tenantId: "tnt_test",
  sessionId: SESSION_ID,
  ownerUserId: "usr_bot",
  visibility: "private",
  originType: "bot",
  originId: "usr_bot_1",
  originChannel: "feishu",
  workspaceId: null,
  teamSnapshot,
  metadata: {},
  permissionMode: null,
};

function withLegacyStore(run) {
  // 历史形状夹具：复刻生产库存量 DDL——team_snapshot 实际为可空列（当年 ADD COLUMN
  // 未带 NOT NULL，SQLite 对非空表也不允许无默认值的 NOT NULL 加列），且行为 NULL。
  const dir = mkdtempSync(join(tmpdir(), "ragsystem-anchor-"));
  const dbPath = join(dir, "conversation.db");
  const store = createConversationStore({ dbPath, dataRoot: process.cwd() });
  store.createSession(CREATE_INPUT);
  const raw = new DatabaseSync(dbPath);
  raw.exec("ALTER TABLE sessions DROP COLUMN team_snapshot");
  raw.exec("ALTER TABLE sessions ADD COLUMN team_snapshot TEXT");
  try {
    run(store);
  } finally {
    raw.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("getSession hydrates the legacy NULL team_snapshot shape to null instead of throwing", () => {
  withLegacyStore((store) => {
    const session = store.getSession(SESSION_ID);
    assert.ok(session);
    assert.equal(session.team_snapshot, null);
  });
});

test("anchorSessionTeamSnapshot fills the NULL row once, then stays idempotent", () => {
  withLegacyStore((store) => {
    assert.equal(store.anchorSessionTeamSnapshot(SESSION_ID, teamSnapshot), true);
    const anchored = store.getSession(SESSION_ID);
    assert.equal(anchored.team_snapshot?.team_revision, teamSnapshot.team_revision);

    // 已锚定行：不再回填（形态驱动，不看版本号）。
    assert.equal(store.anchorSessionTeamSnapshot(SESSION_ID, teamSnapshot), false);
    // 不存在的行：无副作用。
    assert.equal(store.anchorSessionTeamSnapshot("missing-session", teamSnapshot), false);
  });
});

test("legacy reserved metadata keys are hydrated out on read and self-heal on rewrite", () => {
  // 历史形状：保留字规则收紧前写入的 team/entry_agent 自由 metadata。
  const dir = mkdtempSync(join(tmpdir(), "ragsystem-meta-"));
  const dbPath = join(dir, "conversation.db");
  const store = createConversationStore({ dbPath, dataRoot: process.cwd() });
  store.createSession(CREATE_INPUT);
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE sessions SET metadata=? WHERE session_id=?").run(
    JSON.stringify({ chatId: "oc_0d2d", team: "2", entry_agent: "orchestrator_agent" }),
    SESSION_ID,
  );
  try {
    // 读取：保留字剔除，业务键保留。
    const session = store.getSession(SESSION_ID);
    assert.deepEqual(session.metadata, { chatId: "oc_0d2d" });

    // 合并更新不再被存量保留字炸掉（曾在此抛 "metadata.team 是保留字段"），且回写干净形状。
    store.updateSessionMetadata(SESSION_ID, { chatId: "oc_new" });
    const healed = store.getSession(SESSION_ID);
    assert.deepEqual(healed.metadata, { chatId: "oc_new" });
  } finally {
    raw.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
