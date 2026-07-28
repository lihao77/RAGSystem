import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import type {
  BotConfig,
  BotConfigUpdate,
  BotCronTask,
  BotSummary,
  TenantBotSummary,
} from "../../contracts/bot.js";
import type { BotCronTaskClaim, BotWithConfig, DaemonBotRepository } from "../../contracts/bot-repository.js";
import type { SecretCoordinates, SecretMutation, SecretResolver } from "@ragsystem/backend-core/contracts/integrations/secret-resolver.js";
import type { Bot } from "@ragsystem/backend-core/contracts/control-plane/user.js";
import { createTenantId, createUserId, type TenantId, type UserId } from "@ragsystem/backend-core/identity/types.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";

const MASKED_SECRET = "***";
const SECRET_FIELDS = [
  "feishu.app_secret",
  "feishu.token",
  "feishu.encoding_aes_key",
  "feishu.route_token",
] as const;
type BotSecretField = typeof SECRET_FIELDS[number];

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

export class PostgresBotRepository implements DaemonBotRepository {
  constructor(
    readonly pool: Pool,
    private readonly secrets: SecretResolver,
  ) {}

  async create(input: Parameters<DaemonBotRepository["create"]>[0]): Promise<Bot> {
    return this.transaction(async (client) => {
      const owner = await client.query<{ type: string }>("SELECT type FROM control_users WHERE id=$1 FOR UPDATE", [input.ownerId]);
      if (!owner.rows[0]) throw new HttpError(404, "not_found", "bot owner 不存在");
      if (owner.rows[0].type !== "human") throw new HttpError(404, "not_found", "bot owner 不存在");
      const membership = await client.query("SELECT 1 FROM control_memberships WHERE user_id=$1 AND tenant_id=$2", [input.ownerId, input.tenantId]);
      if (!membership.rows[0]) throw new HttpError(403, "forbidden", "bot owner 不是该租户成员");
      const id = createUserId(`usr_bot_${randomUUID().replaceAll("-", "")}`);
      const createdAt = new Date().toISOString();
      await client.query(`
        INSERT INTO control_users(id, display_name, created_at, status, type, owner_id)
        VALUES ($1, $2, $3, 'active', 'bot', $4)
      `, [id, input.displayName, createdAt, input.ownerId]);
      await client.query(`
        INSERT INTO control_memberships(user_id, tenant_id, role) VALUES ($1, $2, 'member')
      `, [id, input.tenantId]);
      await client.query(`
        INSERT INTO control_bot_configs(bot_id, tenant_id, created_at, updated_at)
        VALUES ($1, $2, $3, $3)
      `, [id, input.tenantId, createdAt]);
      return { id, displayName: input.displayName, createdAt, status: "active", type: "bot", owner_id: input.ownerId };
    });
  }

  async get(botId: UserId): Promise<Bot | null> {
    const result = await this.pool.query<BotRow>(`${BOT_SELECT} WHERE id=$1 AND type='bot'`, [botId]);
    return result.rows[0] ? mapBot(result.rows[0]) : null;
  }

  async rename(botId: UserId, displayName: string): Promise<boolean> {
    return changed(await this.pool.query("UPDATE control_users SET display_name=$1 WHERE id=$2 AND type='bot'", [displayName, botId]));
  }

  async delete(botId: UserId): Promise<boolean> {
    return this.transaction(async (client) => {
      const row = await client.query<{ tenant_id: string }>(`
        SELECT tenant_id FROM control_bot_configs WHERE bot_id=$1 FOR UPDATE
      `, [botId]);
      if (!row.rows[0]) return false;
      const deleted = changed(await client.query("DELETE FROM control_users WHERE id=$1 AND type='bot'", [botId]));
      if (deleted) {
        for (const field of SECRET_FIELDS) {
          await this.secrets.mutate(secretCoordinates(createTenantId(row.rows[0].tenant_id), botId, field), { kind: "clear" });
        }
      }
      return deleted;
    });
  }

  async isOwnedBy(botId: UserId | string, ownerId: UserId | string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM control_users WHERE id=$1 AND type='bot' AND owner_id=$2", [botId, ownerId]);
    return (result.rowCount ?? 0) > 0;
  }

  async assertOwner(botId: UserId, ownerId: UserId): Promise<Bot> {
    const bot = await this.get(botId);
    if (!bot) throw new HttpError(404, "not_found", "bot 不存在");
    if (bot.owner_id !== ownerId) throw new HttpError(403, "forbidden", "无权管理该 bot");
    return bot;
  }

  async listByOwner(ownerId: UserId): Promise<Bot[]> {
    const result = await this.pool.query<BotRow>(`${BOT_SELECT} WHERE type='bot' AND owner_id=$1 ORDER BY created_at, id`, [ownerId]);
    return result.rows.map(mapBot);
  }

  async listWithConfigByOwner(ownerId: UserId): Promise<BotWithConfig[]> {
    const bots = await this.listByOwner(ownerId);
    return Promise.all(bots.map(async (bot) => {
      const config = await this.getConfig(bot.id);
      if (!config) throw new Error(`bot 配置不存在: ${bot.id}`);
      return { ...bot, config };
    }));
  }

  async listOwnedBotIdsForTenant(ownerId: UserId, tenantId: TenantId): Promise<UserId[]> {
    const result = await this.pool.query<{ id: string }>(`
      SELECT u.id FROM control_users u
      JOIN control_memberships m ON m.user_id=u.id
      WHERE u.type='bot' AND u.owner_id=$1 AND m.tenant_id=$2
      ORDER BY u.created_at, u.id
    `, [ownerId, tenantId]);
    return result.rows.map((row) => createUserId(row.id));
  }

  async listAll(): Promise<BotSummary[]> {
    const result = await this.pool.query<BotSummaryRow>(`${BOT_SUMMARY_SELECT}, bc.tenant_id, t.display_name AS tenant_name
      FROM control_users b
      JOIN control_users o ON o.id=b.owner_id
      JOIN control_bot_configs bc ON bc.bot_id=b.id
      JOIN control_tenants t ON t.id=bc.tenant_id
      WHERE b.type='bot' ORDER BY b.created_at DESC, b.id`);
    return result.rows.map((row) => ({ ...mapTenantBotSummary(row), tenantId: createTenantId(row.tenant_id), tenantName: row.tenant_name }));
  }

  async listByTenant(tenantId: TenantId): Promise<TenantBotSummary[]> {
    const result = await this.pool.query<TenantBotSummaryRow>(`${BOT_SUMMARY_SELECT}
      FROM control_users b
      JOIN control_users o ON o.id=b.owner_id
      JOIN control_bot_configs bc ON bc.bot_id=b.id
      JOIN control_memberships m ON m.user_id=b.id AND m.tenant_id=bc.tenant_id
      WHERE b.type='bot' AND bc.tenant_id=$1 ORDER BY b.created_at, b.id`, [tenantId]);
    return result.rows.map(mapTenantBotSummary);
  }

  async getConfig(botId: UserId): Promise<BotConfig | null> {
    const config = await this.getRuntimeConfig(botId);
    return config ? maskBotConfig(config) : null;
  }

  async getRuntimeConfig(botId: UserId): Promise<BotConfig | null> {
    const result = await this.pool.query<BotConfigRow>(`${BOT_CONFIG_SELECT} WHERE bot_id=$1`, [botId]);
    const row = result.rows[0];
    if (!row) return null;
    const tenantId = createTenantId(row.tenant_id);
    const [cronTasks, appSecret, token, encodingKey, routeToken] = await Promise.all([
      this.listCronTasks(botId),
      this.resolveSecret(tenantId, botId, "feishu.app_secret"),
      this.resolveSecret(tenantId, botId, "feishu.token"),
      this.resolveSecret(tenantId, botId, "feishu.encoding_aes_key"),
      this.resolveSecret(tenantId, botId, "feishu.route_token"),
    ]);
    return mapBotConfig(row, cronTasks, { appSecret, token, encodingKey, routeToken });
  }

  async updateConfig(botId: UserId, patch: BotConfigUpdate): Promise<BotConfig> {
    const current = await this.getRuntimeConfig(botId);
    if (!current) throw new HttpError(404, "not_found", "bot 配置不存在");
    const next = mergeConfig(current, patch);
    const secretMutations = secretMutationsForPatch(patch);
    for (const [field, mutation] of secretMutations) {
      await this.secrets.mutate(secretCoordinates(current.tenant_id, botId, field), mutation);
    }
    const routeToken = patch.feishu?.route_token === undefined || patch.feishu.route_token === MASKED_SECRET
      ? current.feishu.route_token
      : patch.feishu.route_token;
    await this.pool.query(`
      UPDATE control_bot_configs SET
        enabled=$1, team=$2, entry_agent=$3, session_id=$4, default_session_ttl=$5, permission_mode=$6,
        feishu_app_id=$7, feishu_receive_mode=$8, route_token_digest=$9,
        feishu_default_chat_id=$10, feishu_enabled=$11, updated_at=$12
      WHERE bot_id=$13
    `, [next.enabled, next.team, next.entry_agent, next.session_id, next.default_session_ttl, next.permission_mode,
      next.feishu.app_id, next.feishu.receive_mode, routeToken ? digest(routeToken) : null,
      next.feishu.default_chat_id, next.feishu.enabled, next.updated_at, botId]);
    const updated = await this.getRuntimeConfig(botId);
    if (!updated) throw new Error(`bot 配置不存在: ${botId}`);
    return maskBotConfig(updated);
  }

  async listAllEnabledFeishu(): Promise<BotConfig[]> {
    const result = await this.pool.query<{ bot_id: string }>(`
      SELECT bc.bot_id FROM control_bot_configs bc
      JOIN control_users u ON u.id=bc.bot_id
      WHERE bc.enabled=TRUE AND bc.feishu_enabled=TRUE AND u.type='bot' AND u.status='active'
      ORDER BY bc.bot_id
    `);
    const configs = await Promise.all(result.rows.map((row) => this.getRuntimeConfig(createUserId(row.bot_id))));
    return configs.filter((config): config is BotConfig => config !== null);
  }

  async resolveWebhookTarget(routeToken: string) {
    if (!routeToken) return null;
    const result = await this.pool.query<{ bot_id: string; tenant_id: string }>(`
      SELECT bc.bot_id, bc.tenant_id
      FROM control_bot_configs bc
      JOIN control_users u ON u.id=bc.bot_id
      WHERE bc.route_token_digest=$1 AND bc.enabled=TRUE AND bc.feishu_enabled=TRUE
        AND bc.feishu_receive_mode='webhook' AND u.type='bot' AND u.status='active'
      LIMIT 1
    `, [digest(routeToken)]);
    const row = result.rows[0];
    return row ? { tenantId: createTenantId(row.tenant_id), botId: createUserId(row.bot_id) } : null;
  }

  async listCronTasks(botId: UserId): Promise<BotCronTask[]> {
    const result = await this.pool.query<BotCronTaskRow>(`${BOT_CRON_SELECT} WHERE bot_id=$1 ORDER BY task_id`, [botId]);
    return result.rows.map(mapCronTask);
  }

  async claimDueCronTasks(input: {
    now: number;
    leaseOwner: string;
    leaseSeconds?: number;
    limit?: number;
  }): Promise<BotCronTaskClaim[]> {
    const leaseSeconds = Math.max(5, Math.min(Math.trunc(input.leaseSeconds ?? 300), 86_400));
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 500));
    return this.transaction(async (client) => {
      const due = await client.query<{ bot_id: string; task_id: string }>(`
        SELECT task.bot_id, task.task_id
        FROM control_bot_cron_tasks task
        JOIN control_users u ON u.id=task.bot_id
        WHERE task.enabled=TRUE AND task.next_run IS NOT NULL AND task.next_run <= $1
          AND (task.lease_expires_at IS NULL OR task.lease_expires_at <= $1)
          AND u.type='bot' AND u.status='active'
        ORDER BY task.bot_id, task.task_id
        FOR UPDATE OF task SKIP LOCKED
        LIMIT $2
      `, [input.now, limit]);
      const claimed: BotCronTaskClaim[] = [];
      for (const row of due.rows) {
        const claimToken = randomUUID();
        const attemptId = randomUUID();
        const leaseExpiresAt = input.now + leaseSeconds;
        const updated = await client.query(`
          UPDATE control_bot_cron_tasks
          SET lease_owner=$1, lease_token=$2, lease_expires_at=$3,
              last_attempt_id=$4, attempt_count=attempt_count+1
          WHERE bot_id=$5 AND task_id=$6
        `, [input.leaseOwner, claimToken, leaseExpiresAt, attemptId, row.bot_id, row.task_id]);
        if ((updated.rowCount ?? 0) === 0) continue;
        claimed.push({ botId: createUserId(row.bot_id), taskId: row.task_id, claimToken, attemptId, leaseOwner: input.leaseOwner, leaseExpiresAt });
      }
      return claimed;
    });
  }

  async completeCronTaskClaim(input: { botId: UserId; taskId: string; claimToken: string }): Promise<boolean> {
    return changed(await this.pool.query(`
      UPDATE control_bot_cron_tasks
      SET lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE bot_id=$1 AND task_id=$2 AND lease_token=$3
    `, [input.botId, input.taskId, input.claimToken]));
  }

  async releaseCronTaskClaim(input: { botId: UserId; taskId: string; claimToken: string }): Promise<boolean> {
    return this.completeCronTaskClaim(input);
  }

  async getCronTask(botId: UserId, taskId: string): Promise<BotCronTask | null> {
    const result = await this.pool.query<BotCronTaskRow>(`${BOT_CRON_SELECT} WHERE bot_id=$1 AND task_id=$2`, [botId, taskId]);
    return result.rows[0] ? mapCronTask(result.rows[0]) : null;
  }

  async createCronTask(botId: UserId, input: Parameters<DaemonBotRepository["createCronTask"]>[1]): Promise<BotCronTask> {
    const result = await this.pool.query<BotCronTaskRow>(`
      INSERT INTO control_bot_cron_tasks(
        bot_id, task_id, cron, task, entry_agent, enabled, push_platform, push_chat_id, next_run
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING ${BOT_CRON_COLUMNS}
    `, [botId, input.task_id, input.cron, input.task, input.entry_agent ?? null, input.enabled ?? true,
      input.push_platform ?? null, input.push_chat_id ?? null, input.next_run ?? null]);
    return mapCronTask(requiredRow(result));
  }

  async updateCronTask(botId: UserId, taskId: string, patch: Parameters<DaemonBotRepository["updateCronTask"]>[2], options?: Parameters<DaemonBotRepository["updateCronTask"]>[3]): Promise<BotCronTask | null> {
    const current = await this.getCronTask(botId, taskId);
    if (!current) return null;
    const next = { ...current, ...defined(patch) };
    const result = await this.pool.query<BotCronTaskRow>(`
      UPDATE control_bot_cron_tasks SET cron=$1, task=$2, entry_agent=$3, enabled=$4,
        push_platform=$5, push_chat_id=$6, next_run=$7, last_run=$8, last_result=$9
      WHERE bot_id=$10 AND task_id=$11 AND ($12::text IS NULL OR lease_token=$12) RETURNING ${BOT_CRON_COLUMNS}
    `, [next.cron, next.task, next.entry_agent, next.enabled, next.push_platform, next.push_chat_id,
      next.next_run, next.last_run, next.last_result, botId, taskId, options?.claimToken ?? null]);
    return result.rows[0] ? mapCronTask(result.rows[0]) : null;
  }

  async deleteCronTask(botId: UserId, taskId: string): Promise<boolean> {
    return changed(await this.pool.query("DELETE FROM control_bot_cron_tasks WHERE bot_id=$1 AND task_id=$2", [botId, taskId]));
  }

  private resolveSecret(tenantId: TenantId, botId: UserId, field: BotSecretField): Promise<string | null> {
    return this.secrets.resolve(secretCoordinates(tenantId, botId, field));
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) {
        if (error instanceof Error) error.cause ??= rollbackError;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

const BOT_SELECT = "SELECT id, display_name, created_at, status, type, owner_id FROM control_users";
const BOT_SUMMARY_SELECT = `SELECT b.id, b.display_name, b.created_at, b.status,
  o.display_name AS owner_name, bc.enabled, bc.feishu_enabled, bc.feishu_receive_mode, bc.entry_agent`;
const BOT_CONFIG_SELECT = `SELECT bot_id, tenant_id, enabled, team, entry_agent, session_id,
  default_session_ttl, permission_mode, feishu_app_id, feishu_receive_mode,
  feishu_default_chat_id, feishu_enabled, created_at, updated_at FROM control_bot_configs`;
const BOT_CRON_COLUMNS = `bot_id, task_id, cron, task, entry_agent, enabled, push_platform,
  push_chat_id, next_run, last_run, last_result`;
const BOT_CRON_SELECT = `SELECT ${BOT_CRON_COLUMNS} FROM control_bot_cron_tasks`;

interface BotRow extends QueryResultRow { id: string; display_name: string; created_at: Date | string; status: string; type: string; owner_id: string | null }
interface TenantBotSummaryRow extends QueryResultRow { id: string; display_name: string; created_at: Date | string; status: string; owner_name: string; enabled: boolean; feishu_enabled: boolean; feishu_receive_mode: string; entry_agent: string | null }
interface BotSummaryRow extends TenantBotSummaryRow { tenant_id: string; tenant_name: string }
interface BotConfigRow extends QueryResultRow { bot_id: string; tenant_id: string; enabled: boolean; team: string | null; entry_agent: string | null; session_id: string | null; default_session_ttl: number; permission_mode: BotConfig["permission_mode"]; feishu_app_id: string | null; feishu_receive_mode: "webhook" | "long_connection"; feishu_default_chat_id: string | null; feishu_enabled: boolean; created_at: Date | string; updated_at: Date | string }
interface BotCronTaskRow extends QueryResultRow { bot_id: string; task_id: string; cron: string; task: string; entry_agent: string | null; enabled: boolean; push_platform: "feishu" | null; push_chat_id: string | null; next_run: number | null; last_run: number | null; last_result: string | null }

function mapBot(row: BotRow): Bot {
  if (row.type !== "bot" || !row.owner_id) throw new Error(`无效 bot 用户记录: ${row.id}`);
  return { id: createUserId(row.id), displayName: row.display_name, createdAt: timestamp(row.created_at),
    status: row.status === "disabled" ? "disabled" : "active", type: "bot", owner_id: createUserId(row.owner_id) };
}

function mapTenantBotSummary(row: TenantBotSummaryRow): TenantBotSummary {
  return { id: createUserId(row.id), displayName: row.display_name, createdAt: timestamp(row.created_at),
    status: row.status === "disabled" ? "disabled" : "active", ownerName: row.owner_name,
    enabled: row.enabled, feishuEnabled: row.feishu_enabled,
    feishuReceiveMode: row.feishu_receive_mode === "long_connection" ? "long_connection" : "webhook",
    entryAgent: row.entry_agent };
}

function mapBotConfig(
  row: BotConfigRow,
  cronTasks: BotCronTask[],
  secrets: { appSecret: string | null; token: string | null; encodingKey: string | null; routeToken: string | null },
): BotConfig {
  return { bot_id: createUserId(row.bot_id), tenant_id: createTenantId(row.tenant_id), enabled: row.enabled,
    team: row.team, entry_agent: row.entry_agent, session_id: row.session_id, default_session_ttl: row.default_session_ttl,
    permission_mode: row.permission_mode, feishu: { enabled: row.feishu_enabled, app_id: row.feishu_app_id,
      app_secret: secrets.appSecret, token: secrets.token, encoding_aes_key: secrets.encodingKey,
      receive_mode: row.feishu_receive_mode, route_token: secrets.routeToken,
      default_chat_id: row.feishu_default_chat_id }, cron_tasks: cronTasks,
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at) };
}

function mapCronTask(row: BotCronTaskRow): BotCronTask {
  return { bot_id: createUserId(row.bot_id), task_id: row.task_id, cron: row.cron, task: row.task,
    entry_agent: row.entry_agent, enabled: row.enabled, push_platform: row.push_platform,
    push_chat_id: row.push_chat_id, next_run: numberOrNull(row.next_run), last_run: numberOrNull(row.last_run),
    last_result: row.last_result };
}

function mergeConfig(current: BotConfig, patch: BotConfigUpdate): BotConfig {
  const feishuPatch = patch.feishu ?? {};
  const feishu = { ...current.feishu };
  for (const [key, value] of Object.entries(feishuPatch)) {
    if (value !== undefined && value !== MASKED_SECRET) (feishu as Record<string, unknown>)[key] = value;
  }
  return {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    team: patch.team === undefined ? current.team : patch.team,
    entry_agent: patch.entry_agent === undefined ? current.entry_agent : patch.entry_agent,
    session_id: patch.session_id ?? current.session_id,
    default_session_ttl: patch.default_session_ttl ?? current.default_session_ttl,
    permission_mode: patch.permission_mode ?? current.permission_mode,
    feishu,
    updated_at: new Date().toISOString(),
  };
}

function maskBotConfig(config: BotConfig): BotConfig {
  const masked = structuredClone(config) as BotConfig;
  if (masked.feishu.app_secret) masked.feishu.app_secret = MASKED_SECRET;
  if (masked.feishu.token) masked.feishu.token = MASKED_SECRET;
  if (masked.feishu.encoding_aes_key) masked.feishu.encoding_aes_key = MASKED_SECRET;
  return masked;
}

function secretMutationsForPatch(patch: BotConfigUpdate): Array<[BotSecretField, SecretMutation]> {
  const feishu = patch.feishu;
  if (!feishu) return [];
  const values: Array<[BotSecretField, unknown]> = [
    ["feishu.app_secret", feishu.app_secret],
    ["feishu.token", feishu.token],
    ["feishu.encoding_aes_key", feishu.encoding_aes_key],
    ["feishu.route_token", feishu.route_token],
  ];
  return values.flatMap(([field, value]) => value === undefined || value === MASKED_SECRET
    ? []
    : [[field, value === null || value === "" ? { kind: "clear" } : { kind: "set", value: String(value) }] as [BotSecretField, SecretMutation]]);
}

function secretCoordinates(tenantId: TenantId, botId: UserId, field: BotSecretField): SecretCoordinates {
  return { tenantId, purpose: "bot", resourceId: botId, field };
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function timestamp(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function numberOrNull(value: number | string | null): number | null { return value === null ? null : Number(value); }
function changed(result: QueryResult): boolean { return (result.rowCount ?? 0) > 0; }
function requiredRow<Row extends QueryResultRow>(result: QueryResult<Row>): Row {
  const row = result.rows[0]; if (!row) throw new Error("PostgreSQL bot write did not return a row"); return row;
}
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
