import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createTenantId, createUserId } from "../../../src/identity/types.js";
import {
  CONTROL_LATEST_SCHEMA_VERSION,
  createControlStore,
} from "../../../src/services/stores/control-store/index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ControlStore", () => {
  it("在 systemRoot/control.db 建库并推进独立版本", () => {
    const systemRoot = makeSystemRoot();
    const store = createControlStore(systemRoot);
    store.close();

    const dbPath = path.join(systemRoot, "control.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(CONTROL_LATEST_SCHEMA_VERSION);
    const columns = db.prepare("PRAGMA table_info(widget_apps)").all() as unknown as Array<{ name: string; notnull: number }>;
    expect(columns).toContainEqual(expect.objectContaining({ name: "tenant_id", notnull: 1 }));
    const indexes = db.prepare("PRAGMA index_list(widget_apps)").all() as unknown as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain("idx_widget_apps_tenant_id");
    const userColumns = db.prepare("PRAGMA table_info(users)").all() as unknown as Array<{ name: string }>;
    expect(userColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["username", "password_hash", "platform_role", "status", "type", "owner_id"]));
    const tenantColumns = db.prepare("PRAGMA table_info(tenants)").all() as unknown as Array<{ name: string }>;
    expect(tenantColumns.map((column) => column.name)).toContain("status");
    const controlIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as unknown as Array<{ name: string }>;
    expect(controlIndexes.map((index) => index.name)).toEqual(expect.arrayContaining(["idx_users_status", "idx_tenants_status", "idx_users_platform_role", "idx_users_owner_id"]));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_sessions'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_settings'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_configs'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_cron_tasks'").get()).toBeTruthy();
    db.close();
  });

  it("支持 Tenant CRUD", () => {
    const store = createControlStore(makeSystemRoot());
    const tenantId = createTenantId("tnt_acme");
    store.createTenant({ id: tenantId, displayName: "Acme" });
    expect(store.getTenant(tenantId)?.displayName).toBe("Acme");
    expect(store.listTenants()).toHaveLength(1);
    expect(store.updateTenant(tenantId, "Acme China")).toBe(true);
    expect(store.getTenant(tenantId)?.displayName).toBe("Acme China");
    expect(store.deleteTenant(tenantId)).toBe(true);
    expect(store.getTenant(tenantId)).toBeNull();
    store.close();
  });

  it("支持 User CRUD", () => {
    const store = createControlStore(makeSystemRoot());
    const userId = createUserId("usr_alice");
    store.createUser({ id: userId, displayName: "Alice" });
    expect(store.getUser(userId)?.displayName).toBe("Alice");
    expect(store.listUsers()).toHaveLength(1);
    expect(store.updateUser(userId, "Alice Zhang")).toBe(true);
    expect(store.getUser(userId)?.displayName).toBe("Alice Zhang");
    expect(store.deleteUser(userId)).toBe(true);
    expect(store.getUser(userId)).toBeNull();
    store.close();
  });

  it("支持 owner-only Bot CRUD 并建立租户成员关系", () => {
    const store = createControlStore(makeSystemRoot());
    const tenantId = createTenantId("tnt_acme");
    const ownerId = createUserId("usr_owner");
    const otherId = createUserId("usr_other");
    store.createTenant({ id: tenantId, displayName: "Acme" });
    store.createUser({ id: ownerId, displayName: "Owner" });
    store.createUser({ id: otherId, displayName: "Other" });
    store.upsertMembership({ userId: ownerId, tenantId, role: "member" });

    const bot = store.createBot({ tenantId, ownerId, displayName: "Support Bot" });
    expect(bot).toMatchObject({ displayName: "Support Bot", type: "bot", owner_id: ownerId, status: "active" });
    expect(store.getBot(bot.id)).toEqual(bot);
    expect(store.getUser(bot.id)).toEqual(bot);
    expect(store.listUsers()).toEqual(expect.arrayContaining([expect.objectContaining({ id: bot.id, type: "bot" })]));
    expect(store.listAllUsers().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: ownerId, type: "human" })]));
    expect(store.listAllUsers().items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: bot.id })]));
    expect(store.listAllBots()).toEqual([expect.objectContaining({
      id: bot.id,
      displayName: "Support Bot",
      tenantId,
      tenantName: "Acme",
      ownerName: "Owner",
      enabled: false,
      feishuEnabled: false,
      feishuReceiveMode: "webhook",
      entryAgent: null,
    })]);
    expect(store.listBotsByTenant(tenantId)).toEqual([expect.objectContaining({
      id: bot.id,
      ownerName: "Owner",
      enabled: false,
      feishuEnabled: false,
      feishuReceiveMode: "webhook",
      entryAgent: null,
    })]);
    expect(store.listBotsByTenant(tenantId)[0]).not.toHaveProperty("tenantId");
    expect(store.listBotsByTenant(tenantId)[0]).not.toHaveProperty("tenantName");
    expect(store.getMembership(bot.id, tenantId)?.role).toBe("member");
    expect(store.getBotConfig(bot.id)).toMatchObject({
      bot_id: bot.id,
      tenant_id: tenantId,
      enabled: false,
      default_session_ttl: 86400,
      permission_mode: "relaxed",
      feishu: { enabled: false, receive_mode: "webhook" },
      cron_tasks: [],
    });
    expect(store.listBotsByOwner(ownerId)).toEqual([bot]);
    expect(store.listBotsWithConfig(ownerId)).toEqual([expect.objectContaining({ id: bot.id, config: expect.objectContaining({ bot_id: bot.id }) })]);
    expect(store.listBotsByOwner(otherId)).toEqual([]);
    expect(store.isBotOwnedBy(bot.id, ownerId)).toBe(true);
    expect(store.isBotOwnedBy(bot.id, otherId)).toBe(false);
    expect(store.getUserWithCredentials(bot.id)).toBeNull();
    const updated = store.updateBotConfig(bot.id, {
      enabled: true,
      entry_agent: "orchestrator_agent",
      permission_mode: "standard",
      feishu: { enabled: true, app_id: "cli", app_secret: "secret", token: "token", encoding_aes_key: "key", receive_mode: "webhook" },
    });
    expect(store.listAllBots()[0]).toMatchObject({ enabled: true, feishuEnabled: true, feishuReceiveMode: "webhook", entryAgent: "orchestrator_agent" });
    expect(store.listAllBots()[0]).not.toHaveProperty("app_secret");
    expect(store.listAllBots()[0]).not.toHaveProperty("token");
    expect(store.listAllBots()[0]).not.toHaveProperty("encoding_aes_key");
    expect(updated.feishu).toMatchObject({ app_secret: "***", token: "***", encoding_aes_key: "***" });
    expect(updated.permission_mode).toBe("standard");
    expect(store.getBotRuntimeConfig(bot.id)?.feishu.app_secret).toBe("secret");
    store.updateBotConfig(bot.id, { feishu: { app_secret: "***", token: "***", encoding_aes_key: "***" } });
    expect(store.getBotRuntimeConfig(bot.id)?.feishu.app_secret).toBe("secret");
    const cron = store.createBotCronTask(bot.id, {
      task_id: "daily",
      cron: "0 9 * * *",
      task: "report",
      entry_agent: null,
      enabled: true,
      push_platform: null,
      push_chat_id: null,
      next_run: 123,
    });
    expect(store.getBotCronTask(bot.id, "daily")).toEqual(cron);
    expect(store.listBotCronTasks(bot.id)).toEqual([cron]);
    expect(store.updateBotCronTask(bot.id, "daily", { last_result: "ok" })?.last_result).toBe("ok");
    expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.getBot(bot.id)).toBeNull();
    expect(store.getBotConfig(bot.id)).toBeNull();
    expect(store.getBotCronTask(bot.id, "daily")).toBeNull();
    expect(store.getMembership(bot.id, tenantId)).toBeNull();
    store.close();
  });

  it("隔离用户凭据并支持 session 与 settings", () => {
    const store = createControlStore(makeSystemRoot());
    const tenantId = createTenantId("tnt_acme");
    const userId = createUserId("usr_alice");
    store.createTenant({ id: tenantId, displayName: "Acme" });
    store.createUser({ id: userId, displayName: "Alice", username: "alice", password_hash: "secret-hash" });
    expect(store.getUserByUsername("alice")).toEqual(expect.objectContaining({ id: userId, username: "alice" }));
    expect(store.getUser(userId)).not.toHaveProperty("passwordHash");
    expect(store.getUserWithCredentials(userId)?.passwordHash).toBe("secret-hash");
    store.recordSession({ jti: "jti-1", userId, tenantId, issuedAt: 10, expiresAt: 20 });
    expect(store.isSessionRevoked(tenantId, "jti-1")).toBe(false);
    expect(store.revokeSession("jti-1")).toBe(true);
    expect(store.isSessionRevoked(tenantId, "jti-1")).toBe(true);
    expect(store.pruneExpiredSessions(21)).toBe(1);
    store.setSetting("installed", "true");
    expect(store.getSetting("installed")).toBe("true");
    expect(store.getAllSettings()).toEqual({ installed: "true" });
    store.close();
  });

  it("支持 Membership 新增、改角色、查询和删除", () => {
    const store = createControlStore(makeSystemRoot());
    const tenantId = createTenantId("tnt_acme");
    const userId = createUserId("usr_alice");
    store.createTenant({ id: tenantId, displayName: "Acme" });
    store.createUser({ id: userId, displayName: "Alice" });
    store.upsertMembership({ userId, tenantId, role: "member" });
    expect(store.getMembership(userId, tenantId)?.role).toBe("member");
    store.upsertMembership({ userId, tenantId, role: "admin" });
    expect(store.listMembershipsByTenant(tenantId)).toEqual([{ userId, tenantId, role: "admin", type: "human" }]);
    expect(store.listMembershipsByUser(userId)).toEqual([{ userId, tenantId, role: "admin", type: "human" }]);
    expect(store.deleteMembership(userId, tenantId)).toBe(true);
    expect(store.getMembership(userId, tenantId)).toBeNull();
    store.close();
  });

  it("租户成员列表只返回 human，bot 由租户 Bot 查询返回", () => {
    const store = createControlStore(makeSystemRoot());
    const tenantId = createTenantId("tnt_acme");
    const ownerId = createUserId("usr_owner");
    store.createTenant({ id: tenantId, displayName: "Acme" });
    store.createUser({ id: ownerId, displayName: "Owner" });
    store.upsertMembership({ userId: ownerId, tenantId, role: "owner" });
    const bot = store.createBot({ tenantId, ownerId, displayName: "Private Bot" });

    expect(store.getMembership(bot.id, tenantId)).not.toBeNull();
    expect(store.listMembershipsByTenant(tenantId)).toEqual([{ userId: ownerId, tenantId, role: "owner", type: "human" }]);
    expect(store.listBotsByTenant(tenantId)).toEqual([expect.objectContaining({ id: bot.id, ownerName: "Owner" })]);
    expect(store.deleteMembership(bot.id, tenantId)).toBe(true);
    expect(store.listBotsByTenant(tenantId)).toEqual([]);
    store.close();
  });

  it("在 store 事务内阻止租户失去最后一个 owner", () => {
    const store = createControlStore(makeSystemRoot());
    const tenantId = createTenantId("tnt_acme");
    const ownerOne = createUserId("usr_owner_one");
    const ownerTwo = createUserId("usr_owner_two");
    store.createTenant({ id: tenantId, displayName: "Acme" });
    store.createUser({ id: ownerOne, displayName: "Owner One" });
    store.createUser({ id: ownerTwo, displayName: "Owner Two" });
    store.upsertMembership({ userId: ownerOne, tenantId, role: "owner" });
    store.upsertMembership({ userId: ownerTwo, tenantId, role: "owner" });

    expect(store.deleteMembership(ownerTwo, tenantId)).toBe(true);
    expect(() => store.upsertMembership({ userId: ownerOne, tenantId, role: "admin" }))
      .toThrow("不能降级租户唯一 owner");
    expect(() => store.deleteMembership(ownerOne, tenantId))
      .toThrow("不能移除租户唯一 owner");
    expect(store.getMembership(ownerOne, tenantId)?.role).toBe("owner");
    store.close();
  });

  it("分页过滤平台用户与租户，并保护最后一个 active 平台 admin", () => {
    const store = createControlStore(makeSystemRoot());
    const tenantId = createTenantId("tnt_acme");
    const adminOne = createUserId("usr_admin_one");
    const adminTwo = createUserId("usr_admin_two");
    store.createTenant({ id: tenantId, displayName: "Acme" });
    store.createUser({ id: adminOne, displayName: "Admin One", platform_role: "admin" });

    expect(store.listAllTenants({ status: "active" }).items).toEqual([expect.objectContaining({ id: tenantId, status: "active" })]);
    expect(store.listAllUsers({ platformRole: "admin" }).items).toEqual([expect.objectContaining({ id: adminOne, platformRole: "admin" })]);
    expect(() => store.setUserStatus(adminOne, "disabled")).toThrow("至少需要保留一个 active 平台管理员");
    expect(() => store.setUserPlatformRole(adminOne, null)).toThrow("至少需要保留一个 active 平台管理员");

    store.createUser({ id: adminTwo, displayName: "Admin Two", platform_role: "admin" });
    expect(store.setUserStatus(adminOne, "disabled")).toBe(true);
    expect(store.getUser(adminOne)?.status).toBe("disabled");
    expect(store.setTenantStatus(tenantId, "suspended")).toBe(true);
    expect(store.getTenant(tenantId)?.status).toBe("suspended");
    store.close();
  });
});

function makeSystemRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-control-store-"));
  tempRoots.push(root);
  return path.join(root, "system");
}

function cronTask(taskId: string, enabled: boolean, nextRun: number) {
  return {
    task_id: taskId,
    cron: "* * * * *",
    task: taskId,
    entry_agent: null,
    enabled,
    push_platform: null,
    push_chat_id: null,
    next_run: nextRun,
  };
}
