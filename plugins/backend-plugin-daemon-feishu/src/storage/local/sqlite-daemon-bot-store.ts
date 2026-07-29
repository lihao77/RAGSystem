import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Bot } from "@ragsystem/backend-core/contracts/control-plane/user.js";
import type { TenantId, UserId } from "@ragsystem/backend-core/identity/types.js";
import { createUserId } from "@ragsystem/backend-core/identity/types.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";

import type {
  BotConfig,
  BotConfigUpdate,
  BotCronTask,
  BotCronTaskCreate,
  BotSummary,
  TenantBotSummary,
} from "../../contracts/bot.js";
import type { BotWithConfig } from "../../contracts/bot-repository.js";

const MASKED_SECRET = "***";
const USER_SELECT = "SELECT id, display_name, created_at, username, platform_role, status, type, owner_id FROM users";
const BOT_SUMMARY_SELECT = `SELECT b.id, b.display_name, b.created_at, b.status,
  o.display_name AS owner_name, bc.enabled, bc.feishu_enabled,
  bc.feishu_receive_mode, bc.entry_agent`;
const BOT_CONFIG_SELECT = `SELECT bot_id, tenant_id, enabled, team, entry_agent, session_id, default_session_ttl, permission_mode,
  feishu_app_id, feishu_app_secret, feishu_token, feishu_encoding_aes_key, feishu_receive_mode,
  feishu_route_token, feishu_default_chat_id, feishu_enabled, created_at, updated_at FROM bot_configs`;
const BOT_CRON_SELECT = `SELECT bot_id, task_id, cron, task, entry_agent, enabled, push_platform,
  push_chat_id, next_run, last_run, last_result FROM bot_cron_tasks`;

/** Plugin-owned synchronous Bot store over the host-provided SQLite control database. */
export class SqliteDaemonBotStore {
  constructor(readonly db: DatabaseSync) {}

  createBot(input: { tenantId: TenantId; ownerId: UserId; displayName: string }): Bot {
    const owner = this.db.prepare(`${USER_SELECT} WHERE id=?`).get(input.ownerId) as UserRow | undefined;
    if (!owner || owner.type !== "human") throw new HttpError(404, "not_found", "bot owner 不存在");
    const membership = this.db.prepare("SELECT 1 AS member FROM memberships WHERE user_id=? AND tenant_id=?")
      .get(input.ownerId, input.tenantId) as { member: number } | undefined;
    if (!membership) throw new HttpError(403, "forbidden", "bot owner 不是该租户成员");
    const id = createUserId(`usr_bot_${randomUUID().replaceAll("-", "")}`);
    const createdAt = new Date().toISOString();
    return this.transaction(() => {
      this.db.prepare("INSERT INTO users(id, display_name, created_at, username, password_hash, platform_role, status, type, owner_id) VALUES (?, ?, ?, NULL, NULL, NULL, 'active', 'bot', ?)")
        .run(id, input.displayName, createdAt, input.ownerId);
      this.db.prepare("INSERT INTO memberships(user_id, tenant_id, role) VALUES (?, ?, 'member')")
        .run(id, input.tenantId);
      this.db.prepare(`
        INSERT INTO bot_configs(
          bot_id, tenant_id, enabled, team, entry_agent, session_id, default_session_ttl, permission_mode,
          feishu_app_id, feishu_app_secret, feishu_token, feishu_encoding_aes_key,
          feishu_receive_mode, feishu_route_token, feishu_default_chat_id, feishu_enabled, created_at, updated_at
        ) VALUES (?, ?, 0, NULL, NULL, NULL, 86400, 'relaxed', NULL, NULL, NULL, NULL, 'webhook', NULL, NULL, 0, ?, ?)
      `).run(id, input.tenantId, createdAt, createdAt);
      return { id, displayName: input.displayName, createdAt, status: "active", type: "bot", owner_id: input.ownerId };
    });
  }

  getBot(id: UserId): Bot | null {
    const row = this.db.prepare(`${USER_SELECT} WHERE id=? AND type='bot'`).get(id) as UserRow | undefined;
    return row ? mapBot(row) : null;
  }

  updateUser(userId: UserId, displayName: string): boolean {
    return Number(this.db.prepare("UPDATE users SET display_name=? WHERE id=? AND type='bot'").run(displayName, userId).changes) > 0;
  }

  deleteBot(id: UserId): boolean {
    return Number(this.db.prepare("DELETE FROM users WHERE id=? AND type='bot'").run(id).changes) > 0;
  }

  isBotOwnedBy(botId: UserId | string, ownerId: UserId | string): boolean {
    return this.db.prepare("SELECT 1 AS owned FROM users WHERE id=? AND type='bot' AND owner_id=?")
      .get(botId, ownerId) !== undefined;
  }

  assertBotOwner(botId: UserId, ownerId: UserId): Bot {
    const bot = this.getBot(botId);
    if (!bot) throw new HttpError(404, "not_found", "bot 不存在");
    if (bot.owner_id !== ownerId) throw new HttpError(403, "forbidden", "无权管理该 bot");
    return bot;
  }

  listBotsByOwner(ownerId: UserId): Bot[] {
    const rows = this.db.prepare(`${USER_SELECT} WHERE type='bot' AND owner_id=? ORDER BY created_at, id`)
      .all(ownerId) as unknown as UserRow[];
    return rows.map(mapBot);
  }

  listBotsWithConfig(ownerId: UserId): BotWithConfig[] {
    return this.listBotsByOwner(ownerId).map((bot) => {
      const config = this.getBotConfig(bot.id);
      if (!config) throw new Error(`bot 配置不存在: ${bot.id}`);
      return { ...bot, config };
    });
  }

  getMembership(userId: UserId, tenantId: TenantId): unknown | null {
    return this.db.prepare("SELECT 1 AS member FROM memberships WHERE user_id=? AND tenant_id=?").get(userId, tenantId) ?? null;
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

  getBotConfig(botId: UserId): BotConfig | null {
    const config = this.getBotRuntimeConfig(botId);
    return config ? maskBotConfig(config) : null;
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
        enabled=?, team=?, entry_agent=?, session_id=?, default_session_ttl=?, permission_mode=?,
        feishu_app_id=?, feishu_app_secret=?, feishu_token=?, feishu_encoding_aes_key=?,
        feishu_receive_mode=?, feishu_route_token=?, feishu_default_chat_id=?, feishu_enabled=?, updated_at=?
      WHERE bot_id=?
    `).run(
      boolToInt(next.enabled), next.team, next.entry_agent, next.session_id, next.default_session_ttl, next.permission_mode,
      next.feishu.app_id, next.feishu.app_secret, next.feishu.token, next.feishu.encoding_aes_key,
      next.feishu.receive_mode, next.feishu.route_token, next.feishu.default_chat_id, boolToInt(next.feishu.enabled), next.updated_at, botId,
    );
    return maskBotConfig(next);
  }

  getAllEnabledFeishuBots(): BotConfig[] {
    const rows = this.db.prepare(`${BOT_CONFIG_SELECT} WHERE enabled=1 AND feishu_enabled=1 AND bot_id IN (SELECT id FROM users WHERE type='bot' AND status='active') ORDER BY bot_id`)
      .all() as unknown as BotConfigRow[];
    return rows.map((row) => mapBotConfig(row, this.listBotCronTasks(row.bot_id)));
  }

  listBotCronTasks(botId: UserId): BotCronTask[] {
    const rows = this.db.prepare(`${BOT_CRON_SELECT} WHERE bot_id=? ORDER BY task_id`).all(botId) as unknown as BotCronTaskRow[];
    return rows.map(mapBotCronTask);
  }

  findDueCronTasks(now: number): Array<{ botId: UserId; taskId: string }> {
    const rows = this.db.prepare(`
      SELECT bot_cron_tasks.bot_id AS bot_id, bot_cron_tasks.task_id AS task_id
      FROM bot_cron_tasks
      JOIN users ON users.id=bot_cron_tasks.bot_id
      WHERE bot_cron_tasks.enabled=1 AND bot_cron_tasks.next_run IS NOT NULL
        AND bot_cron_tasks.next_run <= ? AND users.type='bot' AND users.status='active'
      ORDER BY bot_cron_tasks.bot_id, bot_cron_tasks.task_id
    `).all(now) as Array<{ bot_id: UserId; task_id: string }>;
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

  private transaction<T>(operation: () => T): T {
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
}

interface UserRow {
  id: UserId;
  display_name: string;
  created_at: string;
  username: string | null;
  platform_role: string | null;
  status: string;
  type: string;
  owner_id: UserId | null;
}

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

interface BotSummaryRow extends TenantBotSummaryRow {
  tenant_id: TenantId;
  tenant_name: string;
}

interface BotConfigRow {
  bot_id: UserId;
  tenant_id: TenantId;
  enabled: number;
  team: string | null;
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
  feishu_default_chat_id: string | null;
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

function mapBot(row: UserRow): Bot {
  if (row.type !== "bot" || !row.owner_id) throw new Error(`无效 bot 用户记录: ${row.id}`);
  if (row.status !== "active" && row.status !== "disabled") throw new Error(`未知用户状态: ${row.status}`);
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
    ...(row.username ? { username: row.username } : {}),
    status: row.status,
    type: "bot",
    owner_id: row.owner_id,
  };
}

function mapTenantBotSummary(row: TenantBotSummaryRow): TenantBotSummary {
  if (row.status !== "active" && row.status !== "disabled") throw new Error(`未知用户状态: ${row.status}`);
  if (row.feishu_receive_mode !== "webhook" && row.feishu_receive_mode !== "long_connection") {
    throw new Error(`未知飞书接收模式: ${row.feishu_receive_mode}`);
  }
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
    status: row.status,
    ownerName: row.owner_name,
    enabled: row.enabled !== 0,
    feishuEnabled: row.feishu_enabled !== 0,
    feishuReceiveMode: row.feishu_receive_mode,
    entryAgent: row.entry_agent,
  };
}

function mapBotSummary(row: BotSummaryRow): BotSummary {
  return { ...mapTenantBotSummary(row), tenantId: row.tenant_id, tenantName: row.tenant_name };
}

function mapBotConfig(row: BotConfigRow, cronTasks: BotCronTask[]): BotConfig {
  return {
    bot_id: row.bot_id,
    tenant_id: row.tenant_id,
    enabled: row.enabled !== 0,
    team: row.team,
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
      default_chat_id: row.feishu_default_chat_id,
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

function definedConfigFields(patch: BotConfigUpdate): Partial<Pick<BotConfig, "enabled" | "team" | "entry_agent" | "session_id" | "default_session_ttl" | "permission_mode">> {
  const fields: Partial<Pick<BotConfig, "enabled" | "team" | "entry_agent" | "session_id" | "default_session_ttl" | "permission_mode">> = {};
  if (patch.enabled !== undefined) fields.enabled = patch.enabled;
  if (patch.team !== undefined) fields.team = patch.team;
  if (patch.entry_agent !== undefined) fields.entry_agent = patch.entry_agent;
  if (patch.session_id !== undefined) fields.session_id = patch.session_id;
  if (patch.default_session_ttl !== undefined) fields.default_session_ttl = patch.default_session_ttl;
  if (patch.permission_mode !== undefined) fields.permission_mode = patch.permission_mode;
  return fields;
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
    default_chat_id: patch.default_chat_id !== undefined ? patch.default_chat_id : current.default_chat_id,
  };
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}
