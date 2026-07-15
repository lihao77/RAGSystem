import { randomUUID } from "node:crypto";

import type { BotConfig, BotConfigUpdate, BotCronTask, BotCronTaskCreate, BotSummary, TenantBotSummary } from "../../../contracts/bot.js";
import type { Bot, Membership, UserType } from "../../../contracts/user.js";
import type { TenantId, UserId } from "../../../identity/types.js";
import { createUserId } from "../../../identity/types.js";
import { HttpError } from "../../../utils/errors.js";
import { createControlDb, type ControlDb } from "./db.js";

export interface ControlTenant {
  id: TenantId;
  displayName: string;
  createdAt: string;
  status: TenantStatus;
}

export interface ControlUser {
  id: UserId;
  displayName: string;
  createdAt: string;
  username?: string;
  platformRole?: PlatformRole;
  status: UserStatus;
  type: UserType;
  owner_id: UserId | null;
}

export type PlatformRole = "admin";
export type UserStatus = "active" | "disabled";
export type TenantStatus = "active" | "suspended";

export interface PaginatedControlResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ControlUserWithCredentials extends ControlUser {
  passwordHash: string | null;
}

export type ControlMembership = Membership;

export type BotWithConfig = Bot & { config: BotConfig };

const MASKED_SECRET = "***";

export class ControlStore {
  constructor(readonly db: ControlDb) {}

  createTenant(input: { id: TenantId; displayName: string; createdAt?: string; status?: TenantStatus }): ControlTenant {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const status = assertTenantStatus(input.status ?? "active");
    this.db.prepare("INSERT INTO tenants(id, display_name, created_at, status) VALUES (?, ?, ?, ?)")
      .run(input.id, input.displayName, createdAt, status);
    return { id: input.id, displayName: input.displayName, createdAt, status };
  }

  getTenant(id: TenantId): ControlTenant | null {
    const row = this.db.prepare("SELECT id, display_name, created_at, status FROM tenants WHERE id=?").get(id) as TenantRow | undefined;
    return row ? mapTenant(row) : null;
  }

  listTenants(): ControlTenant[] {
    const rows = this.db.prepare("SELECT id, display_name, created_at, status FROM tenants ORDER BY created_at, id").all() as unknown as TenantRow[];
    return rows.map(mapTenant);
  }

  updateTenant(id: TenantId, displayName: string): boolean {
    return Number(this.db.prepare("UPDATE tenants SET display_name=? WHERE id=?").run(displayName, id).changes) > 0;
  }

  deleteTenant(id: TenantId): boolean {
    return Number(this.db.prepare("DELETE FROM tenants WHERE id=?").run(id).changes) > 0;
  }

  createUser(input: { id: UserId; displayName: string; createdAt?: string; username?: string; password_hash?: string; platform_role?: PlatformRole | null; status?: UserStatus }): ControlUser {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const platformRole = assertPlatformRole(input.platform_role ?? null);
    const status = assertUserStatus(input.status ?? "active");
    this.db.prepare("INSERT INTO users(id, display_name, created_at, username, password_hash, platform_role, status, type, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'human', NULL)")
      .run(input.id, input.displayName, createdAt, input.username ?? null, input.password_hash ?? null, platformRole, status);
    return {
      id: input.id,
      displayName: input.displayName,
      createdAt,
      ...(input.username ? { username: input.username } : {}),
      ...(platformRole ? { platformRole } : {}),
      status,
      type: "human",
      owner_id: null,
    };
  }

  createBot(input: { tenantId: TenantId; ownerId: UserId; displayName: string }): Bot {
    const owner = this.getUser(input.ownerId);
    if (!owner || owner.type !== "human") throw new HttpError(404, "not_found", "bot owner 不存在");
    if (!this.getMembership(input.ownerId, input.tenantId)) throw new HttpError(403, "forbidden", "bot owner 不是该租户成员");
    const id = createUserId(`usr_bot_${randomUUID().replaceAll("-", "")}`);
    const createdAt = new Date().toISOString();
    return this.inImmediateTransaction(() => {
      this.db.prepare("INSERT INTO users(id, display_name, created_at, username, password_hash, platform_role, status, type, owner_id) VALUES (?, ?, ?, NULL, NULL, NULL, 'active', 'bot', ?)")
        .run(id, input.displayName, createdAt, input.ownerId);
      this.db.prepare("INSERT INTO memberships(user_id, tenant_id, role) VALUES (?, ?, 'member')")
        .run(id, input.tenantId);
      this.db.prepare(`
        INSERT INTO bot_configs(
          bot_id, tenant_id, enabled, entry_agent, session_id, default_session_ttl, permission_mode,
          feishu_app_id, feishu_app_secret, feishu_token, feishu_encoding_aes_key,
          feishu_receive_mode, feishu_route_token, feishu_enabled, created_at, updated_at
        ) VALUES (?, ?, 0, NULL, NULL, 86400, 'relaxed', NULL, NULL, NULL, NULL, 'webhook', NULL, 0, ?, ?)
      `).run(id, input.tenantId, createdAt, createdAt);
      return { id, displayName: input.displayName, createdAt, status: "active", type: "bot", owner_id: input.ownerId };
    });
  }

  listBotsByOwner(ownerId: UserId): Bot[] {
    const rows = this.db.prepare(`${USER_SELECT} WHERE type='bot' AND owner_id=? ORDER BY created_at, id`)
      .all(ownerId) as unknown as UserRow[];
    return rows.map(mapBot);
  }

  getBot(id: UserId): Bot | null {
    const row = this.db.prepare(`${USER_SELECT} WHERE id=? AND type='bot'`).get(id) as UserRow | undefined;
    return row ? mapBot(row) : null;
  }

  deleteBot(id: UserId): boolean {
    return Number(this.db.prepare("DELETE FROM users WHERE id=? AND type='bot'").run(id).changes) > 0;
  }

  isBotOwnedBy(botId: UserId | string, userId: UserId | string): boolean {
    const row = this.db.prepare("SELECT 1 AS owned FROM users WHERE id=? AND type='bot' AND owner_id=?").get(botId, userId) as { owned: number } | undefined;
    return row !== undefined;
  }

  assertBotOwner(botId: UserId, userId: UserId): Bot {
    const bot = this.getBot(botId);
    if (!bot) throw new HttpError(404, "not_found", "bot 不存在");
    if (bot.owner_id !== userId) throw new HttpError(403, "forbidden", "无权管理该 bot");
    return bot;
  }

  getBotConfig(botId: UserId): BotConfig | null {
    const config = this.getBotRuntimeConfig(botId);
    if (!config) return null;
    return maskBotConfig(config);
  }

  getBotRuntimeConfig(botId: UserId): BotConfig | null {
    const row = this.db.prepare(`${BOT_CONFIG_SELECT} WHERE bot_id=?`).get(botId) as BotConfigRow | undefined;
    return row ? mapBotConfig(row, this.listBotCronTasks(botId)) : null;
  }

  updateBotConfig(botId: UserId, patch: BotConfigUpdate): BotConfig {
    const current = this.getBotRuntimeConfig(botId);
    if (!current) throw new HttpError(404, "not_found", "bot 配置不存在");
    const next: BotConfig = {
      ...current,
      ...definedConfigFields(patch),
      feishu: mergeFeishuPatch(current.feishu, patch.feishu),
      updated_at: new Date().toISOString(),
    };
    restoreMaskedBotSecrets(next, current);
    this.db.prepare(`
      UPDATE bot_configs SET
        enabled=?, entry_agent=?, session_id=?, default_session_ttl=?, permission_mode=?,
        feishu_app_id=?, feishu_app_secret=?, feishu_token=?, feishu_encoding_aes_key=?,
        feishu_receive_mode=?, feishu_route_token=?, feishu_enabled=?, updated_at=?
      WHERE bot_id=?
    `).run(
      boolToInt(next.enabled), next.entry_agent, next.session_id, next.default_session_ttl, next.permission_mode,
      next.feishu.app_id, next.feishu.app_secret, next.feishu.token, next.feishu.encoding_aes_key,
      next.feishu.receive_mode, next.feishu.route_token, boolToInt(next.feishu.enabled), next.updated_at, botId,
    );
    return maskBotConfig(next);
  }

  listBotsWithConfig(ownerId: UserId): BotWithConfig[] {
    return this.listBotsByOwner(ownerId).map((bot) => {
      const config = this.getBotConfig(bot.id);
      if (!config) throw new Error(`bot 配置不存在: ${bot.id}`);
      return { ...bot, config };
    });
  }

  listAllBots(): BotSummary[] {
    const rows = this.db.prepare(`${BOT_SUMMARY_SELECT}, bc.tenant_id, t.display_name AS tenant_name
      FROM users b
      INNER JOIN users o ON o.id=b.owner_id
      INNER JOIN bot_configs bc ON bc.bot_id=b.id
      INNER JOIN tenants t ON t.id=bc.tenant_id
      WHERE b.type='bot'
      ORDER BY b.created_at DESC, b.id`).all() as unknown as BotSummaryRow[];
    return rows.map(mapBotSummary);
  }

  listBotsByTenant(tenantId: TenantId): TenantBotSummary[] {
    const rows = this.db.prepare(`${BOT_SUMMARY_SELECT}
      FROM users b
      INNER JOIN users o ON o.id=b.owner_id
      INNER JOIN bot_configs bc ON bc.bot_id=b.id
      INNER JOIN memberships m ON m.user_id=b.id AND m.tenant_id=bc.tenant_id
      WHERE b.type='bot' AND bc.tenant_id=?
      ORDER BY b.created_at, b.id`).all(tenantId) as unknown as TenantBotSummaryRow[];
    return rows.map(mapTenantBotSummary);
  }

  getAllEnabledFeishuBots(): BotConfig[] {
    const rows = this.db.prepare(`${BOT_CONFIG_SELECT} WHERE enabled=1 AND feishu_enabled=1 AND bot_id IN (SELECT id FROM users WHERE type='bot' AND status='active') ORDER BY bot_id`).all() as unknown as BotConfigRow[];
    return rows.map((row) => mapBotConfig(row, this.listBotCronTasks(row.bot_id)));
  }

  listBotCronTasks(botId: UserId): BotCronTask[] {
    const rows = this.db.prepare(`${BOT_CRON_SELECT} WHERE bot_id=? ORDER BY task_id`).all(botId) as unknown as BotCronTaskRow[];
    return rows.map(mapBotCronTask);
  }

  listDueCronTasks(now: number): Array<{ botId: UserId; taskId: string }> {
    const rows = this.db.prepare(`
      SELECT bot_cron_tasks.bot_id AS bot_id, bot_cron_tasks.task_id AS task_id
      FROM bot_cron_tasks
      JOIN users ON users.id=bot_cron_tasks.bot_id
      WHERE bot_cron_tasks.enabled=1
        AND bot_cron_tasks.next_run IS NOT NULL
        AND bot_cron_tasks.next_run <= ?
        AND users.type='bot'
        AND users.status='active'
      ORDER BY bot_cron_tasks.bot_id, bot_cron_tasks.task_id
    `).all(now) as unknown as DueCronTaskRow[];
    return rows.map((row) => ({ botId: row.bot_id, taskId: row.task_id }));
  }

  getBotCronTask(botId: UserId, taskId: string): BotCronTask | null {
    const row = this.db.prepare(`${BOT_CRON_SELECT} WHERE bot_id=? AND task_id=?`).get(botId, taskId) as BotCronTaskRow | undefined;
    return row ? mapBotCronTask(row) : null;
  }

  createBotCronTask(botId: UserId, input: BotCronTaskCreate & { next_run?: number | null }): BotCronTask {
    this.db.prepare(`
      INSERT INTO bot_cron_tasks(bot_id, task_id, cron, task, entry_agent, enabled, push_platform, push_chat_id, next_run, last_run, last_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(botId, input.task_id, input.cron, input.task, input.entry_agent, boolToInt(input.enabled), input.push_platform, input.push_chat_id, input.next_run ?? null);
    return this.getBotCronTask(botId, input.task_id)!;
  }

  updateBotCronTask(botId: UserId, taskId: string, patch: Partial<Omit<BotCronTask, "bot_id" | "task_id">>): BotCronTask | null {
    const current = this.getBotCronTask(botId, taskId);
    if (!current) return null;
    const next = { ...current, ...definedFields(patch) };
    this.db.prepare(`
      UPDATE bot_cron_tasks SET cron=?, task=?, entry_agent=?, enabled=?, push_platform=?, push_chat_id=?, next_run=?, last_run=?, last_result=?
      WHERE bot_id=? AND task_id=?
    `).run(next.cron, next.task, next.entry_agent, boolToInt(next.enabled), next.push_platform, next.push_chat_id, next.next_run, next.last_run, next.last_result, botId, taskId);
    return this.getBotCronTask(botId, taskId);
  }

  deleteBotCronTask(botId: UserId, taskId: string): boolean {
    return Number(this.db.prepare("DELETE FROM bot_cron_tasks WHERE bot_id=? AND task_id=?").run(botId, taskId).changes) > 0;
  }

  getUser(id: UserId): ControlUser | null {
    const row = this.db.prepare(`${USER_SELECT} WHERE id=?`).get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  getUserByUsername(username: string): ControlUser | null {
    const row = this.db.prepare(`${USER_SELECT} WHERE username=? AND type='human'`).get(username) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  getUserWithCredentials(id: UserId): ControlUserWithCredentials | null {
    const row = this.db.prepare(`${USER_CREDENTIAL_SELECT} WHERE id=? AND type='human'`).get(id) as UserCredentialRow | undefined;
    return row ? { ...mapUser(row), passwordHash: row.password_hash } : null;
  }

  listUsers(): ControlUser[] {
    const rows = this.db.prepare(`${USER_SELECT} ORDER BY created_at, id`).all() as unknown as UserRow[];
    return rows.map(mapUser);
  }

  listAllTenants(input: { limit?: number; offset?: number; status?: TenantStatus; query?: string } = {}): PaginatedControlResult<ControlTenant> {
    const limit = clampPageSize(input.limit);
    const offset = clampPageOffset(input.offset);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.status) {
      clauses.push("status=?");
      params.push(assertTenantStatus(input.status));
    }
    if (input.query?.trim()) {
      clauses.push("(id LIKE ? OR display_name LIKE ?)");
      const pattern = `%${input.query.trim()}%`;
      params.push(pattern, pattern);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM tenants ${where}`).get(...params) as { count: number | bigint };
    const rows = this.db.prepare(`SELECT id, display_name, created_at, status FROM tenants ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as TenantRow[];
    return { items: rows.map(mapTenant), total: Number(totalRow.count), limit, offset };
  }

  listAllUsers(input: { limit?: number; offset?: number; status?: UserStatus; platformRole?: PlatformRole | null; query?: string } = {}): PaginatedControlResult<ControlUser> {
    const limit = clampPageSize(input.limit);
    const offset = clampPageOffset(input.offset);
    const clauses: string[] = ["users.type='human'"];
    const params: Array<string | number> = [];
    if (input.status) {
      clauses.push("users.status=?");
      params.push(assertUserStatus(input.status));
    }
    if (input.platformRole !== undefined) {
      const platformRole = assertPlatformRole(input.platformRole);
      clauses.push(platformRole ? "users.platform_role=?" : "users.platform_role IS NULL");
      if (platformRole) params.push(platformRole);
    }
    if (input.query?.trim()) {
      clauses.push("(users.id LIKE ? OR users.display_name LIKE ? OR users.username LIKE ?)");
      const pattern = `%${input.query.trim()}%`;
      params.push(pattern, pattern, pattern);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(...params) as { count: number | bigint };
    const rows = this.db.prepare(`${USER_SELECT} ${where} ORDER BY users.created_at DESC, users.id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as UserRow[];
    return { items: rows.map(mapUser), total: Number(totalRow.count), limit, offset };
  }

  setTenantStatus(id: TenantId, status: TenantStatus): boolean {
    return Number(this.db.prepare("UPDATE tenants SET status=? WHERE id=?").run(assertTenantStatus(status), id).changes) > 0;
  }

  setUserStatus(id: UserId, status: UserStatus): boolean {
    const normalized = assertUserStatus(status);
    return this.inImmediateTransaction(() => {
      const user = this.getUser(id);
      if (!user) return false;
      if (normalized === "disabled" && user.status === "active" && user.platformRole === "admin") {
        this.assertAnotherActivePlatformAdmin(id);
      }
      return Number(this.db.prepare("UPDATE users SET status=? WHERE id=?").run(normalized, id).changes) > 0;
    });
  }

  setUserPlatformRole(id: UserId, platformRole: PlatformRole | null): boolean {
    const normalized = assertPlatformRole(platformRole);
    return this.inImmediateTransaction(() => {
      const user = this.getUser(id);
      if (!user) return false;
      if (normalized === null && user.platformRole === "admin" && user.status === "active") {
        this.assertAnotherActivePlatformAdmin(id);
      }
      return Number(this.db.prepare("UPDATE users SET platform_role=? WHERE id=?").run(normalized, id).changes) > 0;
    });
  }

  recordPlatformAudit(input: { actorUserId: UserId; action: string; targetTenantId?: TenantId; targetResource: string; detail?: Record<string, unknown> }): void {
    this.db.prepare(`
      INSERT INTO platform_audit(actor_user_id, action, target_tenant_id, target_resource, detail_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.actorUserId, input.action, input.targetTenantId ?? null, input.targetResource, input.detail ? JSON.stringify(input.detail) : null);
  }

  updateUser(id: UserId, displayName: string): boolean {
    return Number(this.db.prepare("UPDATE users SET display_name=? WHERE id=?").run(displayName, id).changes) > 0;
  }

  deleteUser(id: UserId): boolean {
    return Number(this.db.prepare("DELETE FROM users WHERE id=?").run(id).changes) > 0;
  }

  upsertMembership(input: Omit<ControlMembership, "type">): ControlMembership {
    return this.inImmediateTransaction(() => {
      const user = this.getUser(input.userId);
      if (!user) throw new HttpError(404, "not_found", "用户不存在");
      const existing = this.getMembership(input.userId, input.tenantId);
      if (existing?.role === "owner" && input.role !== "owner" && this.countOwners(input.tenantId) <= 1) {
        throw new HttpError(403, "forbidden", "不能降级租户唯一 owner");
      }
      this.db.prepare(`
        INSERT INTO memberships(user_id, tenant_id, role) VALUES (?, ?, ?)
        ON CONFLICT(user_id, tenant_id) DO UPDATE SET role=excluded.role
      `).run(input.userId, input.tenantId, input.role);
      return { ...input, type: user.type };
    });
  }

  getMembership(userId: UserId, tenantId: TenantId): ControlMembership | null {
    const row = this.db.prepare(`SELECT memberships.user_id, memberships.tenant_id, memberships.role, users.type
      FROM memberships
      INNER JOIN users ON users.id=memberships.user_id
      WHERE memberships.user_id=? AND memberships.tenant_id=?`)
      .get(userId, tenantId) as MembershipRow | undefined;
    return row ? mapMembership(row) : null;
  }

  listMembershipsByTenant(tenantId: TenantId): ControlMembership[] {
    const rows = this.db.prepare(`SELECT memberships.user_id, memberships.tenant_id, memberships.role, users.type
      FROM memberships
      INNER JOIN users ON users.id=memberships.user_id
      WHERE memberships.tenant_id=? AND users.type='human'
      ORDER BY memberships.user_id`)
      .all(tenantId) as unknown as MembershipRow[];
    return rows.map(mapMembership);
  }

  listMembershipsByUser(userId: UserId): ControlMembership[] {
    const rows = this.db.prepare(`SELECT memberships.user_id, memberships.tenant_id, memberships.role, users.type
      FROM memberships
      INNER JOIN users ON users.id=memberships.user_id
      WHERE memberships.user_id=?
      ORDER BY memberships.tenant_id`)
      .all(userId) as unknown as MembershipRow[];
    return rows.map(mapMembership);
  }

  deleteMembership(userId: UserId, tenantId: TenantId): boolean {
    return this.inImmediateTransaction(() => {
      const existing = this.getMembership(userId, tenantId);
      if (!existing) return false;
      if (existing.role === "owner" && this.countOwners(tenantId) <= 1) {
        throw new HttpError(403, "forbidden", "不能移除租户唯一 owner");
      }
      return Number(this.db.prepare("DELETE FROM memberships WHERE user_id=? AND tenant_id=?").run(userId, tenantId).changes) > 0;
    });
  }

  private countOwners(tenantId: TenantId): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM memberships WHERE tenant_id=? AND role='owner'")
      .get(tenantId) as { count: number | bigint };
    return Number(row.count);
  }

  private assertAnotherActivePlatformAdmin(excludedUserId: UserId): void {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE platform_role='admin' AND status='active' AND id<>?")
      .get(excludedUserId) as { count: number | bigint };
    if (Number(row.count) < 1) {
      throw new HttpError(409, "last_platform_admin", "至少需要保留一个 active 平台管理员");
    }
  }

  private inImmediateTransaction<T>(operation: () => T): T {
    if (this.db.isTransaction) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordSession(input: { jti: string; userId: UserId; tenantId: TenantId; issuedAt: number; expiresAt: number }): void {
    this.db.prepare(`
      INSERT INTO user_sessions(jti, user_id, tenant_id, issued_at, expires_at, revoked)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(input.jti, input.userId, input.tenantId, input.issuedAt, input.expiresAt);
  }

  isSessionRevoked(tenantId: TenantId, jti: string): boolean {
    const row = this.db.prepare("SELECT revoked FROM user_sessions WHERE tenant_id=? AND jti=?").get(tenantId, jti) as { revoked: number } | undefined;
    return !row || row.revoked !== 0;
  }

  revokeSession(jti: string): boolean {
    return Number(this.db.prepare("UPDATE user_sessions SET revoked=1 WHERE jti=?").run(jti).changes) > 0;
  }

  pruneExpiredSessions(now = Math.floor(Date.now() / 1000)): number {
    return Number(this.db.prepare("DELETE FROM user_sessions WHERE expires_at < ?").run(now).changes);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM system_settings WHERE key=?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO system_settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM system_settings ORDER BY key").all() as unknown as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  close(): void {
    this.db.close();
  }
}

export function createControlStore(systemRoot: string): ControlStore {
  return new ControlStore(createControlDb(systemRoot));
}

const USER_SELECT = "SELECT id, display_name, created_at, username, platform_role, status, type, owner_id FROM users";
const USER_CREDENTIAL_SELECT = "SELECT id, display_name, created_at, username, password_hash, platform_role, status, type, owner_id FROM users";
const BOT_SUMMARY_SELECT = `SELECT b.id, b.display_name, b.created_at, b.status,
  o.display_name AS owner_name, bc.enabled, bc.feishu_enabled,
  bc.feishu_receive_mode, bc.entry_agent`;
const BOT_CONFIG_SELECT = `SELECT bot_id, tenant_id, enabled, entry_agent, session_id, default_session_ttl, permission_mode,
  feishu_app_id, feishu_app_secret, feishu_token, feishu_encoding_aes_key, feishu_receive_mode,
  feishu_route_token, feishu_enabled, created_at, updated_at FROM bot_configs`;
const BOT_CRON_SELECT = `SELECT bot_id, task_id, cron, task, entry_agent, enabled, push_platform,
  push_chat_id, next_run, last_run, last_result FROM bot_cron_tasks`;

interface TenantRow { id: TenantId; display_name: string; created_at: string; status: string; }
interface UserRow { id: UserId; display_name: string; created_at: string; username: string | null; platform_role: string | null; status: string; type: string; owner_id: UserId | null; }
interface UserCredentialRow extends UserRow { password_hash: string | null; }
interface MembershipRow { user_id: UserId; tenant_id: TenantId; role: string; type: string; }
interface TenantBotSummaryRow {
  id: UserId;
  display_name: string;
  created_at: string;
  status: string;
  owner_name: string;
  enabled: number;
  feishu_enabled: number;
  feishu_receive_mode: string;
  entry_agent: string | null;
}
interface BotSummaryRow extends TenantBotSummaryRow { tenant_id: TenantId; tenant_name: string; }
interface BotConfigRow {
  bot_id: UserId;
  tenant_id: TenantId;
  enabled: number;
  entry_agent: string | null;
  session_id: string | null;
  default_session_ttl: number;
  permission_mode: BotConfig["permission_mode"];
  feishu_app_id: string | null;
  feishu_app_secret: string | null;
  feishu_token: string | null;
  feishu_encoding_aes_key: string | null;
  feishu_receive_mode: "webhook" | "long_connection";
  feishu_route_token: string | null;
  feishu_enabled: number;
  created_at: string;
  updated_at: string;
}
interface BotCronTaskRow {
  bot_id: UserId;
  task_id: string;
  cron: string;
  task: string;
  entry_agent: string | null;
  enabled: number;
  push_platform: "feishu" | null;
  push_chat_id: string | null;
  next_run: number | null;
  last_run: number | null;
  last_result: string | null;
}
interface DueCronTaskRow { bot_id: UserId; task_id: string; }

function mapTenant(row: TenantRow): ControlTenant {
  return { id: row.id, displayName: row.display_name, createdAt: row.created_at, status: assertTenantStatus(row.status) };
}
function mapUser(row: UserRow): ControlUser {
  const platformRole = assertPlatformRole(row.platform_role);
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
    ...(row.username ? { username: row.username } : {}),
    ...(platformRole ? { platformRole } : {}),
    status: assertUserStatus(row.status),
    type: assertUserType(row.type),
    owner_id: row.owner_id,
  };
}
function mapTenantBotSummary(row: TenantBotSummaryRow): TenantBotSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
    status: assertUserStatus(row.status),
    ownerName: row.owner_name,
    enabled: row.enabled !== 0,
    feishuEnabled: row.feishu_enabled !== 0,
    feishuReceiveMode: assertFeishuReceiveMode(row.feishu_receive_mode),
    entryAgent: row.entry_agent,
  };
}
function mapBotSummary(row: BotSummaryRow): BotSummary {
  return { ...mapTenantBotSummary(row), tenantId: row.tenant_id, tenantName: row.tenant_name };
}
function mapBot(row: UserRow): Bot {
  const user = mapUser(row);
  if (user.type !== "bot" || !user.owner_id) throw new Error(`无效 bot 用户记录: ${row.id}`);
  return { ...user, type: "bot", owner_id: user.owner_id };
}
function mapBotConfig(row: BotConfigRow, cronTasks: BotCronTask[]): BotConfig {
  return {
    bot_id: row.bot_id,
    tenant_id: row.tenant_id,
    enabled: row.enabled !== 0,
    entry_agent: row.entry_agent,
    session_id: row.session_id,
    default_session_ttl: row.default_session_ttl,
    permission_mode: row.permission_mode,
    feishu: {
      enabled: row.feishu_enabled !== 0,
      app_id: row.feishu_app_id,
      app_secret: row.feishu_app_secret,
      token: row.feishu_token,
      encoding_aes_key: row.feishu_encoding_aes_key,
      receive_mode: row.feishu_receive_mode,
      route_token: row.feishu_route_token,
    },
    cron_tasks: cronTasks,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
function mapBotCronTask(row: BotCronTaskRow): BotCronTask {
  return {
    bot_id: row.bot_id,
    task_id: row.task_id,
    cron: row.cron,
    task: row.task,
    entry_agent: row.entry_agent,
    enabled: row.enabled !== 0,
    push_platform: row.push_platform,
    push_chat_id: row.push_chat_id,
    next_run: row.next_run,
    last_run: row.last_run,
    last_result: row.last_result,
  };
}
function mapMembership(row: MembershipRow): ControlMembership {
  return { userId: row.user_id, tenantId: row.tenant_id, role: assertTenantRole(row.role), type: assertUserType(row.type) };
}

function assertPlatformRole(value: unknown): PlatformRole | null {
  if (value === null || value === undefined) return null;
  if (value !== "admin") throw new Error(`未知平台角色: ${String(value)}`);
  return value;
}

function assertUserStatus(value: unknown): UserStatus {
  if (value !== "active" && value !== "disabled") throw new Error(`未知用户状态: ${String(value)}`);
  return value;
}

function assertUserType(value: unknown): UserType {
  if (value !== "human" && value !== "bot") throw new Error(`未知用户类型: ${String(value)}`);
  return value;
}

function assertTenantRole(value: unknown): ControlMembership["role"] {
  if (value !== "owner" && value !== "admin" && value !== "member") throw new Error(`未知租户角色: ${String(value)}`);
  return value;
}

function assertFeishuReceiveMode(value: unknown): TenantBotSummary["feishuReceiveMode"] {
  if (value !== "webhook" && value !== "long_connection") throw new Error(`未知飞书接收模式: ${String(value)}`);
  return value;
}

function maskBotConfig(config: BotConfig): BotConfig {
  const masked = structuredClone(config) as BotConfig;
  if (masked.feishu.app_secret) masked.feishu.app_secret = MASKED_SECRET;
  if (masked.feishu.token) masked.feishu.token = MASKED_SECRET;
  if (masked.feishu.encoding_aes_key) masked.feishu.encoding_aes_key = MASKED_SECRET;
  return masked;
}

function restoreMaskedBotSecrets(next: BotConfig, current: BotConfig): void {
  if (next.feishu.app_secret === MASKED_SECRET) next.feishu.app_secret = current.feishu.app_secret;
  if (next.feishu.token === MASKED_SECRET) next.feishu.token = current.feishu.token;
  if (next.feishu.encoding_aes_key === MASKED_SECRET) next.feishu.encoding_aes_key = current.feishu.encoding_aes_key;
}

function definedConfigFields(patch: BotConfigUpdate): Partial<Pick<BotConfig, "enabled" | "entry_agent" | "session_id" | "default_session_ttl" | "permission_mode">> {
  const fields: Partial<Pick<BotConfig, "enabled" | "entry_agent" | "session_id" | "default_session_ttl" | "permission_mode">> = {};
  if (patch.enabled !== undefined) fields.enabled = patch.enabled;
  if (patch.entry_agent !== undefined) fields.entry_agent = patch.entry_agent;
  if (patch.session_id !== undefined) fields.session_id = patch.session_id;
  if (patch.default_session_ttl !== undefined) fields.default_session_ttl = patch.default_session_ttl;
  if (patch.permission_mode !== undefined) fields.permission_mode = patch.permission_mode;
  return fields;
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function mergeFeishuPatch(current: BotConfig["feishu"], patch: BotConfigUpdate["feishu"]): BotConfig["feishu"] {
  if (!patch) return { ...current };
  return {
    enabled: patch.enabled ?? current.enabled,
    app_id: patch.app_id !== undefined ? patch.app_id : current.app_id,
    app_secret: patch.app_secret !== undefined ? patch.app_secret : current.app_secret,
    token: patch.token !== undefined ? patch.token : current.token,
    encoding_aes_key: patch.encoding_aes_key !== undefined ? patch.encoding_aes_key : current.encoding_aes_key,
    receive_mode: patch.receive_mode ?? current.receive_mode,
    route_token: patch.route_token !== undefined ? patch.route_token : current.route_token,
  };
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function assertTenantStatus(value: unknown): TenantStatus {
  if (value !== "active" && value !== "suspended") throw new Error(`未知租户状态: ${String(value)}`);
  return value;
}

function clampPageSize(value: number | undefined): number {
  return Math.min(200, Math.max(1, Number.isFinite(value) ? Math.trunc(value as number) : 20));
}

function clampPageOffset(value: number | undefined): number {
  return Math.max(0, Number.isFinite(value) ? Math.trunc(value as number) : 0);
}

export { CONTROL_LATEST_SCHEMA_VERSION } from "./migrations.js";
