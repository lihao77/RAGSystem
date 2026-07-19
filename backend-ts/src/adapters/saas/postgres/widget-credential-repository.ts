import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type {
  CreatedWidgetAppCredential,
  WidgetAppCredential,
  WidgetCredentialRepository,
  WidgetSessionToken,
} from "../../../contracts/control-plane/widget-credentials.js";
import { createTenantId, type TenantId } from "../../../identity/types.js";

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

interface AppRow extends QueryResultRow {
  app_key: string;
  tenant_id: string;
  secret_hash: string;
  secret_prefix: string;
  display_name: string;
  allowed_origins: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
}

interface TokenRow extends QueryResultRow {
  jti: string;
  app_key: string;
  issued_at: number | string;
  expires_at: number | string;
  revoked: boolean;
}

interface AuditRow extends QueryResultRow {
  id: number | string;
  app_key: string;
  action: string;
  actor: string;
  detail_json: Record<string, unknown> | string | null;
  created_at: Date | string;
}

export interface PostgresWidgetCredentialRepositoryOptions {
  ownsPool?: boolean;
}

export interface CreatePostgresWidgetCredentialRepositoryOptions {
  connectionString: string;
  pool?: Pool;
  poolMax?: number;
}

/** PostgreSQL implementation of the asynchronous Widget credential boundary. */
export class PostgresWidgetCredentialRepository implements WidgetCredentialRepository {
  private readonly ownsPool: boolean;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    readonly pool: Pool,
    options: PostgresWidgetCredentialRepositoryOptions = {},
  ) {
    this.ownsPool = options.ownsPool ?? false;
  }

  readonly apps: WidgetCredentialRepository["apps"] = {
    create: async (input) => this.createApp(input),
    resolveTenantId: async (appKey) => this.resolveTenantId(appKey),
    verifySecret: async (tenantId, appKey, secret) => this.verifySecret(tenantId, appKey, secret),
    get: async (tenantId, appKey) => this.getApp(this.pool, tenantId, appKey),
    list: async (tenantId) => this.listApps(tenantId),
    update: async (tenantId, appKey, input) => this.updateApp(tenantId, appKey, input),
    rotateSecret: async (tenantId, appKey) => this.rotateSecret(tenantId, appKey),
    revoke: async (tenantId, appKey) => this.revokeApp(tenantId, appKey),
    listAllowedOrigins: async (tenantId) => this.listAllowedOrigins(tenantId),
  };

  readonly tokens: WidgetCredentialRepository["tokens"] = {
    record: async (input) => this.recordToken(input),
    isRevoked: async (tenantId, jti) => this.isTokenRevoked(tenantId, jti),
    revoke: async (tenantId, jti) => this.revokeToken(tenantId, jti),
    listByApp: async (tenantId, appKey) => this.listTokensByApp(tenantId, appKey),
    pruneExpired: async (nowSeconds) => this.pruneExpiredTokens(nowSeconds),
  };

  readonly audit: WidgetCredentialRepository["audit"] = {
    record: async (tenantId, input) => this.recordAudit(tenantId, input),
    list: async (tenantId, appKey, limit, offset) => this.listAudit(tenantId, appKey, limit, offset),
  };

  async startPruning(intervalMs = PRUNE_INTERVAL_MS): Promise<void> {
    if (this.pruneTimer) return;
    await this.pruneExpiredTokens(Math.floor(Date.now() / 1000));
    this.pruneTimer = setInterval(() => {
      void this.pruneExpiredTokens(Math.floor(Date.now() / 1000)).catch(() => undefined);
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (!this.pruneTimer) return;
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop();
    if (this.ownsPool) await this.pool.end();
  }

  private async createApp(input: { tenantId: TenantId; display_name: string; allowed_origins?: string[] }): Promise<CreatedWidgetAppCredential> {
    const appKey = `wid_pk_${randomBytes(24).toString("hex")}`;
    const secret = `wid_sk_${randomBytes(32).toString("hex")}`;
    const secretPrefix = secret.slice(0, 12);
    const allowedOrigins = (input.allowed_origins ?? []).join(",").trim();
    await this.pool.query(`
      INSERT INTO control_widget_apps(app_key, tenant_id, secret_hash, secret_prefix, display_name, allowed_origins)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [appKey, input.tenantId, hashSecret(secret), secretPrefix, input.display_name, allowedOrigins]);
    return { app_key: appKey, tenant_id: input.tenantId, secret, secret_prefix: secretPrefix, display_name: input.display_name, allowed_origins: input.allowed_origins ?? [] };
  }

  private async resolveTenantId(appKey: string): Promise<TenantId | null> {
    const result = await this.pool.query<{ tenant_id: string }>("SELECT tenant_id FROM control_widget_apps WHERE app_key=$1", [appKey]);
    return result.rows[0] ? createTenantId(result.rows[0].tenant_id) : null;
  }

  private async verifySecret(tenantId: TenantId, appKey: string, secret: string): Promise<WidgetAppCredential | null> {
    const app = await this.getApp(this.pool, tenantId, appKey);
    if (!app || app.revoked_at) return null;
    const expected = Buffer.from(app.secret_hash, "hex");
    const actual = Buffer.from(hashSecret(secret), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? app : null;
  }

  private async getApp(queryable: Queryable, tenantId: TenantId, appKey: string, forUpdate = false): Promise<WidgetAppCredential | null> {
    const result = await queryable.query<AppRow>(`${APP_SELECT} WHERE tenant_id=$1 AND app_key=$2${forUpdate ? " FOR UPDATE" : ""}`, [tenantId, appKey]);
    return result.rows[0] ? mapApp(result.rows[0]) : null;
  }

  private async listApps(tenantId: TenantId): Promise<WidgetAppCredential[]> {
    const result = await this.pool.query<AppRow>(`${APP_SELECT} WHERE tenant_id=$1 ORDER BY created_at DESC, app_key DESC`, [tenantId]);
    return result.rows.map(mapApp);
  }

  private async updateApp(tenantId: TenantId, appKey: string, input: { display_name?: string; allowed_origins?: string[] }): Promise<WidgetAppCredential | null> {
    const current = await this.getApp(this.pool, tenantId, appKey);
    if (!current) return null;
    await this.pool.query(`UPDATE control_widget_apps SET display_name=$1, allowed_origins=$2 WHERE tenant_id=$3 AND app_key=$4`, [
      input.display_name ?? current.display_name,
      input.allowed_origins?.join(",") ?? current.allowed_origins,
      tenantId,
      appKey,
    ]);
    return this.getApp(this.pool, tenantId, appKey);
  }

  private async rotateSecret(tenantId: TenantId, appKey: string): Promise<CreatedWidgetAppCredential | null> {
    return this.transaction(async (client) => {
      const app = await this.getApp(client, tenantId, appKey, true);
      if (!app || app.revoked_at) return null;
      const secret = `wid_sk_${randomBytes(32).toString("hex")}`;
      const secretPrefix = secret.slice(0, 12);
      await client.query("UPDATE control_widget_apps SET secret_hash=$1, secret_prefix=$2 WHERE tenant_id=$3 AND app_key=$4", [hashSecret(secret), secretPrefix, tenantId, appKey]);
      await client.query("UPDATE control_widget_tokens SET revoked=TRUE WHERE app_key=$1 AND revoked=FALSE", [appKey]);
      return { app_key: app.app_key, tenant_id: app.tenant_id, secret, secret_prefix: secretPrefix, display_name: app.display_name, allowed_origins: splitOrigins(app.allowed_origins) };
    });
  }

  private async revokeApp(tenantId: TenantId, appKey: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query("UPDATE control_widget_apps SET revoked_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND app_key=$2 AND revoked_at IS NULL", [tenantId, appKey]);
      if (!changed(result)) return false;
      await client.query("UPDATE control_widget_tokens SET revoked=TRUE WHERE app_key=$1 AND revoked=FALSE", [appKey]);
      return true;
    });
  }

  private async listAllowedOrigins(tenantId: TenantId): Promise<string[]> {
    const result = await this.pool.query<{ allowed_origins: string }>("SELECT allowed_origins FROM control_widget_apps WHERE tenant_id=$1 AND revoked_at IS NULL AND allowed_origins <> ''", [tenantId]);
    return [...new Set(result.rows.flatMap((row) => splitOrigins(row.allowed_origins)))];
  }

  private async recordToken(input: { tenantId: TenantId; jti: string; app_key: string; issued_at: number; expires_at: number }): Promise<void> {
    const result = await this.pool.query(`
      INSERT INTO control_widget_tokens(jti, app_key, issued_at, expires_at, revoked)
      SELECT $1, app_key, $2, $3, FALSE FROM control_widget_apps WHERE tenant_id=$4 AND app_key=$5
    `, [input.jti, input.issued_at, input.expires_at, input.tenantId, input.app_key]);
    if (!changed(result)) throw new Error("widget app 不存在");
  }

  private async isTokenRevoked(tenantId: TenantId, jti: string): Promise<boolean> {
    const result = await this.pool.query<{ revoked: boolean }>(`SELECT token.revoked FROM control_widget_tokens token JOIN control_widget_apps app ON app.app_key=token.app_key WHERE app.tenant_id=$1 AND token.jti=$2`, [tenantId, jti]);
    return result.rows[0]?.revoked !== false;
  }

  private async revokeToken(tenantId: TenantId, jti: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE control_widget_tokens SET revoked=TRUE WHERE jti=$1 AND app_key IN (SELECT app_key FROM control_widget_apps WHERE tenant_id=$2)`, [jti, tenantId]);
    return changed(result);
  }

  private async listTokensByApp(tenantId: TenantId, appKey: string): Promise<WidgetSessionToken[]> {
    const result = await this.pool.query<TokenRow>(`SELECT token.jti, token.app_key, token.issued_at, token.expires_at, token.revoked FROM control_widget_tokens token JOIN control_widget_apps app ON app.app_key=token.app_key WHERE app.tenant_id=$1 AND token.app_key=$2 ORDER BY token.issued_at DESC`, [tenantId, appKey]);
    return result.rows.map((row) => ({ ...row, issued_at: Number(row.issued_at), expires_at: Number(row.expires_at), revoked: Boolean(row.revoked) }));
  }

  private async pruneExpiredTokens(nowSeconds: number): Promise<number> {
    const result = await this.pool.query("DELETE FROM control_widget_tokens WHERE expires_at < $1", [nowSeconds]);
    return rowCount(result);
  }

  private async recordAudit(tenantId: TenantId, input: { app_key: string; action: string; actor: string; detail?: Record<string, unknown> }): Promise<void> {
    const result = await this.pool.query(`INSERT INTO control_widget_audit(app_key, action, actor, detail_json) SELECT app_key, $1, $2, $3 FROM control_widget_apps WHERE tenant_id=$4 AND app_key=$5`, [input.action, input.actor, input.detail ? JSON.stringify(input.detail) : null, tenantId, input.app_key]);
    if (!changed(result)) throw new Error("widget app 不存在");
  }

  private async listAudit(tenantId: TenantId, appKey: string, limit = 100, offset = 0) {
    const result = await this.pool.query<AuditRow>(`SELECT audit.id, audit.app_key, audit.action, audit.actor, audit.detail_json, audit.created_at FROM control_widget_audit audit JOIN control_widget_apps app ON app.app_key=audit.app_key WHERE app.tenant_id=$1 AND audit.app_key=$2 ORDER BY audit.id DESC LIMIT $3 OFFSET $4`, [tenantId, appKey, limit, offset]);
    return result.rows.map((row) => ({ id: Number(row.id), app_key: row.app_key, action: row.action, actor: row.actor, detail: typeof row.detail_json === "string" ? JSON.parse(row.detail_json) as Record<string, unknown> : row.detail_json, created_at: timestamp(row.created_at) }));
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function createPostgresWidgetCredentialRepository(
  options: CreatePostgresWidgetCredentialRepositoryOptions,
): Promise<PostgresWidgetCredentialRepository> {
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? new Pool({ connectionString: options.connectionString, max: options.poolMax ?? 10 });
  return new PostgresWidgetCredentialRepository(pool, { ownsPool });
}

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

const APP_SELECT = "SELECT app_key, tenant_id, secret_hash, secret_prefix, display_name, allowed_origins, created_at, revoked_at FROM control_widget_apps";

function mapApp(row: AppRow): WidgetAppCredential {
  return { app_key: row.app_key, tenant_id: createTenantId(row.tenant_id), secret_hash: row.secret_hash, secret_prefix: row.secret_prefix, display_name: row.display_name, allowed_origins: row.allowed_origins, created_at: timestamp(row.created_at), revoked_at: row.revoked_at == null ? null : timestamp(row.revoked_at) };
}
function hashSecret(secret: string): string { return createHash("sha256").update(secret).digest("hex"); }
function splitOrigins(value: string): string[] { return value.split(",").map((origin) => origin.trim()).filter(Boolean); }
function timestamp(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function changed(result: QueryResult): boolean { return (result.rowCount ?? 0) > 0; }
function rowCount(result: QueryResult): number { return result.rowCount ?? 0; }
