import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { decodeSessionListCursor, encodeSessionListCursor } from "../../src/routes/session-list-cursor.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../src/services/identity/index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function createDirect(store: ReturnType<typeof createConversationStore>, sessionId: string, metadata: Record<string, unknown> = {}) {
  store.createSession({
    tenantId: LOCAL_TENANT_ID,
    sessionId,
    ownerUserId: LOCAL_USER_ID,
    visibility: "private",
    originType: "direct",
    originId: null,
    originChannel: "web",
    workspaceId: null,
    metadata,
  });
}

function list(store: ReturnType<typeof createConversationStore>, cursor: { activityAt: string; sessionId: string } | null = null) {
  return store.listSessions({
    tenantId: LOCAL_TENANT_ID,
    access: { userId: LOCAL_USER_ID, includeTenant: true },
    limit: 20,
    cursor,
  });
}

describe("SQLite session list projection", () => {
  it("projects only visible root conversation messages with the shared semantics", () => {
    const vectors = [
      { id: "visible-user", role: "user" as const, metadata: {}, threadKey: "root", childAgentId: null, visible: true },
      { id: "visible-assistant", role: "assistant" as const, metadata: {}, threadKey: "root", childAgentId: null, visible: true },
      { id: "tool", role: "tool" as const, metadata: {}, threadKey: "root", childAgentId: null, visible: false },
      { id: "intermediate", role: "assistant" as const, metadata: { react_intermediate: true }, threadKey: "root", childAgentId: null, visible: false },
      { id: "hidden", role: "assistant" as const, metadata: { visible_to_user: false }, threadKey: "root", childAgentId: null, visible: false },
      { id: "intent", role: "assistant" as const, metadata: { msg_type: "intent" }, threadKey: "root", childAgentId: null, visible: false },
      { id: "observation", role: "system" as const, metadata: { msg_type: "observation" }, threadKey: "root", childAgentId: null, visible: false },
      { id: "child-thread", role: "assistant" as const, metadata: {}, threadKey: "child:1", childAgentId: "child-1", visible: false },
    ];
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      for (const vector of vectors) {
        createDirect(store, vector.id);
        store.addMessage({
          sessionId: vector.id,
          role: vector.role,
          content: vector.id,
          metadata: vector.metadata,
          threadKey: vector.threadKey,
          childAgentId: vector.childAgentId,
        });
        store.rebuildSessionListProjection(vector.id);
      }
      const items = new Map(list(store).items.map((item) => [item.session_id, item]));
      for (const vector of vectors) {
        expect(items.get(vector.id)?.last_message, vector.id).toBe(vector.visible ? vector.id : "");
      }
    } finally {
      store.close();
    }
  });

  it("keeps activity ordering stable for metadata updates and rebuilds after edit and rollback", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      createDirect(store, "session-a");
      const first = store.addMessage({ sessionId: "session-a", role: "user", content: "first" });
      const last = store.addMessage({ sessionId: "session-a", role: "assistant", content: "last" });
      const before = list(store).items[0];

      store.updateSessionMetadata("session-a", { team: "renamed-team" });
      const metadataUpdated = list(store).items[0];
      expect(metadataUpdated).toMatchObject({ title: "first", activity_at: before?.activity_at });

      store.updateMessage({ messageId: last.id, sessionId: "session-a", content: "edited" });
      expect(list(store).items[0]?.last_message).toBe("edited");

      store.deleteMessagesAfter("session-a", { afterSeq: first.seq });
      expect(list(store).items[0]).toMatchObject({ first_message: "first", last_message: "first" });
    } finally {
      store.close();
    }
  });

  it("uses stable activity/session cursor ordering and source/workspace filters", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      const workspace = store.resolveLocalWorkspace({
        workspaceId: "workspace-1",
        tenantId: LOCAL_TENANT_ID,
        kind: "local",
        displayName: "repo",
        rootPath: process.cwd(),
        canonicalKey: "repo",
      });
      store.createSession({
        tenantId: LOCAL_TENANT_ID, sessionId: "bot-session", ownerUserId: LOCAL_USER_ID,
        visibility: "private", originType: "bot", originId: "bot-1", originChannel: "api",
        workspaceId: workspace.workspace_id,
      });
      createDirect(store, "direct-session");
      store.addMessage({ sessionId: "bot-session", role: "user", content: "bot" });
      store.addMessage({ sessionId: "direct-session", role: "user", content: "direct" });

      const firstPage = store.listSessions({
        tenantId: LOCAL_TENANT_ID,
        access: { userId: LOCAL_USER_ID, includeTenant: true },
        limit: 1,
      });
      expect(firstPage.items[0]?.activity_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
      expect(firstPage.nextCursor?.activityAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
      const routeCursor = firstPage.nextCursor
        ? decodeSessionListCursor(encodeSessionListCursor(firstPage.nextCursor))
        : null;
      const secondPage = store.listSessions({
        tenantId: LOCAL_TENANT_ID,
        access: { userId: LOCAL_USER_ID, includeTenant: true },
        limit: 1,
        cursor: routeCursor,
      });
      expect(firstPage.items).toHaveLength(1);
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0]?.session_id).not.toBe(firstPage.items[0]?.session_id);

      const filtered = store.listSessions({
        tenantId: LOCAL_TENANT_ID,
        access: { userId: LOCAL_USER_ID, includeTenant: true },
        limit: 20,
        originType: "bot",
        originId: "bot-1",
        workspaceId: "workspace-1",
      });
      expect(filtered.items.map((item) => item.session_id)).toEqual(["bot-session"]);
      expect(store.listSessionFacets({
        tenantId: LOCAL_TENANT_ID,
        access: { userId: LOCAL_USER_ID, includeTenant: true },
      })).toMatchObject({
        typeCounts: { direct: 1, bot: 1, widget: 0 },
        origins: [{ type: "bot", id: "bot-1", count: 1 }],
        workspaces: [{ workspaceId: "workspace-1", count: 1 }],
      });
    } finally {
      store.close();
    }
  });

  it("rejects shadow domain fields in both create and metadata updates", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      expect(() => createDirect(store, "bad", { workspace_root: process.cwd() })).toThrow("保留字段");
      createDirect(store, "valid");
      expect(() => store.updateSessionMetadata("valid", { origin_type: "widget" })).toThrow("保留字段");
    } finally {
      store.close();
    }
  });

  it("allows identical create replay and rejects immutable identity conflicts", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      createDirect(store, "identity");
      expect(() => createDirect(store, "identity")).not.toThrow();
      expect(() => store.createSession({
        tenantId: LOCAL_TENANT_ID, sessionId: "identity", ownerUserId: "other-user",
        visibility: "private", originType: "direct", originId: null,
        originChannel: "web", workspaceId: null,
      })).toThrow("immutable identity conflict");
    } finally {
      store.close();
    }
  });

  it("fails explicitly for a legacy unversioned database instead of migrating it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-clean-break-"));
    const dbPath = path.join(root, "conversation.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, user_id TEXT)");
    legacy.close();
    try {
      expect(() => createConversationStore({ dbPath, dataRoot: root })).toThrow("obsolete table 'sessions'");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects any unversioned user table, not only legacy session tables", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-clean-break-table-"));
    const dbPath = path.join(root, "conversation.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE resources (resource_id TEXT PRIMARY KEY)");
    legacy.close();
    try {
      expect(() => createConversationStore({ dbPath, dataRoot: root })).toThrow("obsolete table 'resources'");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
