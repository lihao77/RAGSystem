import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type {
  ControlMembership,
  ControlPlane,
  ControlPlaneProvisioning,
  ControlTenant,
  ControlUser,
  ControlUserWithCredentials,
  MembershipDirectory,
  TenantDirectory,
  UserDirectory,
} from "../../../contracts/control-plane/index.js";
import { TenantRoleSchema, UserTypeSchema } from "../../../contracts/control-plane/user.js";
import { createTenantId, createUserId, type TenantId, type UserId } from "../../../identity/types.js";
import { HttpError } from "../../../utils/errors.js";
import {
  POSTGRES_CONTROL_LATEST_SCHEMA_VERSION,
  runPostgresControlMigrations,
} from "./control-migrations.js";

const CONTROL_INSTALL_ADVISORY_LOCK_ID = 0x52414749;
const CONTROL_ADMIN_ADVISORY_LOCK_ID = 0x52414741;

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

export interface PostgresControlPlaneAdapterOptions {
  ownsPool?: boolean;
}

export class PostgresControlPlaneAdapter implements ControlPlane {
  readonly tenants: TenantDirectory;
  readonly users: UserDirectory;
  readonly memberships: MembershipDirectory;
  readonly provisioning: ControlPlaneProvisioning;
  private readonly ownsPool: boolean;
  private closed = false;

  constructor(
    readonly pool: Pool,
    options: PostgresControlPlaneAdapterOptions = {},
  ) {
    this.ownsPool = options.ownsPool ?? false;
    this.tenants = {
      create: async (input) => this.createTenant(this.pool, input),
      get: async (id) => this.getTenant(this.pool, id),
      list: async () => {
        const result = await this.pool.query<TenantRow>(`${TENANT_SELECT} ORDER BY created_at, id`);
        return result.rows.map(mapTenant);
      },
      listPage: async (input = {}) => this.listTenantPage(input),
      updateName: async (id, displayName) => changed(await this.pool.query("UPDATE control_tenants SET display_name=$1 WHERE id=$2", [displayName, id])),
      setStatus: async (id, status) => changed(await this.pool.query("UPDATE control_tenants SET status=$1 WHERE id=$2", [status, id])),
      delete: async (id) => changed(await this.pool.query("DELETE FROM control_tenants WHERE id=$1", [id])),
    };
    this.users = {
      create: async (input) => this.createUser(this.pool, input),
      get: async (id) => this.getUser(this.pool, id),
      findByUsername: async (username) => this.findUserByUsername(this.pool, username, false),
      findCredentialsByUsername: async (username) => this.findUserByUsername(this.pool, username, true),
      list: async () => {
        const result = await this.pool.query<UserRow>(`${USER_SELECT} ORDER BY created_at, id`);
        return result.rows.map(mapUser);
      },
      listPage: async (input = {}) => this.listUserPage(input),
      updateName: async (id, displayName) => changed(await this.pool.query("UPDATE control_users SET display_name=$1 WHERE id=$2", [displayName, id])),
      setStatus: async (id, status) => this.transaction((client) => this.setUserStatus(client, id, status)),
      setPlatformRole: async (id, role) => this.transaction((client) => this.setUserPlatformRole(client, id, role)),
      delete: async (id) => changed(await this.pool.query("DELETE FROM control_users WHERE id=$1", [id])),
    };
    this.memberships = {
      upsert: async (input) => this.transaction((client) => this.upsertMembership(client, input)),
      get: async (userId, tenantId) => this.getMembership(this.pool, userId, tenantId),
      listByTenant: async (tenantId) => this.listMemberships("tenant_id", tenantId),
      listByUser: async (userId) => this.listMemberships("user_id", userId),
      delete: async (userId, tenantId) => this.transaction((client) => this.deleteMembership(client, userId, tenantId)),
      findFirstActiveForLogin: async (userId, allowPlatformFallback) => this.findFirstActiveForLogin(userId, allowPlatformFallback),
    };
    this.provisioning = {
      install: async (input) => this.install(input),
      createTenantWithOwner: async (input) => this.createTenantWithOwner(input),
      inviteOrAttachMember: async (input) => this.inviteOrAttachMember(input),
      removeMember: async (input) => this.transaction((client) => this.deleteMembership(client, input.userId, input.tenantId)),
      ensureLocalIdentity: async (input) => this.ensureLocalIdentity(input),
    };
  }

  readonly settings: ControlPlane["settings"] = {
    get: async (key) => {
      const result = await this.pool.query<{ value: string }>("SELECT value FROM control_system_settings WHERE key=$1", [key]);
      return result.rows[0]?.value ?? null;
    },
    getAll: async () => {
      const result = await this.pool.query<{ key: string; value: string }>("SELECT key, value FROM control_system_settings ORDER BY key");
      return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
    },
    set: async (key, value) => this.setSetting(this.pool, key, value),
    setMany: async (settings) => this.transaction(async (client) => {
      for (const [key, value] of Object.entries(settings)) await this.setSetting(client, key, value);
    }),
  };

  readonly sessions: ControlPlane["sessions"] = {
    record: async (input) => {
      await this.pool.query(`
        INSERT INTO control_user_sessions(jti, user_id, tenant_id, issued_at, expires_at, revoked)
        VALUES ($1, $2, $3, $4, $5, FALSE)
      `, [input.jti, input.userId, input.tenantId, input.issuedAt, input.expiresAt]);
    },
    isRevoked: async (tenantId, jti) => {
      const result = await this.pool.query<{ revoked: boolean }>(
        "SELECT revoked FROM control_user_sessions WHERE tenant_id=$1 AND jti=$2",
        [tenantId, jti],
      );
      return result.rows[0]?.revoked !== false;
    },
    revoke: async (jti) => changed(await this.pool.query("UPDATE control_user_sessions SET revoked=TRUE WHERE jti=$1", [jti])),
    pruneExpired: async (now = Math.floor(Date.now() / 1000)) => rowCount(await this.pool.query("DELETE FROM control_user_sessions WHERE expires_at < $1", [now])),
  };

  readonly audit: ControlPlane["audit"] = {
    record: async (input) => this.recordAudit(this.pool, input),
  };

  readonly commands: ControlPlane["commands"] = {
    setTenantStatus: async (input) => this.transaction(async (client) => {
      const result = await client.query("UPDATE control_tenants SET status=$1 WHERE id=$2", [input.status, input.tenantId]);
      if (!changed(result)) return null;
      await this.recordAudit(client, {
        actorUserId: input.actorUserId,
        action: "set_tenant_status",
        targetTenantId: input.tenantId,
        targetResource: `tenant:${input.tenantId}`,
        detail: { status: input.status },
      });
      return this.getTenant(client, input.tenantId);
    }),
    setUserStatus: async (input) => this.transaction(async (client) => {
      if (!await this.setUserStatus(client, input.userId, input.status)) return null;
      await this.recordAudit(client, {
        actorUserId: input.actorUserId,
        action: "set_user_status",
        targetResource: `user:${input.userId}`,
        detail: { status: input.status },
      });
      return this.getUser(client, input.userId);
    }),
    setUserPlatformRole: async (input) => this.transaction(async (client) => {
      if (!await this.setUserPlatformRole(client, input.userId, input.platformRole)) return null;
      await this.recordAudit(client, {
        actorUserId: input.actorUserId,
        action: "set_user_platform_role",
        targetResource: `user:${input.userId}`,
        detail: { platformRole: input.platformRole },
      });
      return this.getUser(client, input.userId);
    }),
  };

  readonly health: ControlPlane["health"] = {
    checkReadiness: async () => {
      try {
        const probe = await this.pool.query<{ ready: number }>("SELECT 1 AS ready");
        const version = await this.pool.query<{ version: number | string }>(
          "SELECT version FROM ragsystem_control_schema_migrations ORDER BY version DESC LIMIT 1",
        );
        const currentSchemaVersion = Number(version.rows[0]?.version ?? 0);
        return {
          ready: probe.rows[0]?.ready === 1 && currentSchemaVersion === POSTGRES_CONTROL_LATEST_SCHEMA_VERSION,
          currentSchemaVersion,
          latestSchemaVersion: POSTGRES_CONTROL_LATEST_SCHEMA_VERSION,
        };
      } catch {
        return { ready: false, currentSchemaVersion: 0, latestSchemaVersion: POSTGRES_CONTROL_LATEST_SCHEMA_VERSION };
      }
    },
  };

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await this.pool.end();
  }

  private async createTenant(db: Queryable, input: Parameters<TenantDirectory["create"]>[0]): Promise<ControlTenant> {
    const result = await db.query<TenantRow>(`
      INSERT INTO control_tenants(id, display_name, created_at, status)
      VALUES ($1, $2, $3, $4) RETURNING id, display_name, created_at, status
    `, [input.id, input.displayName, input.createdAt ?? new Date().toISOString(), input.status ?? "active"]);
    return mapTenant(requiredRow(result));
  }

  private async getTenant(db: Queryable, id: TenantId): Promise<ControlTenant | null> {
    const result = await db.query<TenantRow>(`${TENANT_SELECT} WHERE id=$1`, [id]);
    return result.rows[0] ? mapTenant(result.rows[0]) : null;
  }

  private async createUser(db: Queryable, input: Parameters<UserDirectory["create"]>[0]): Promise<ControlUser> {
    const result = await db.query<UserRow>(`
      INSERT INTO control_users(id, display_name, created_at, username, password_hash, platform_role, status, type, owner_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'human', NULL)
      RETURNING ${USER_COLUMNS}
    `, [input.id, input.displayName, input.createdAt ?? new Date().toISOString(), input.username ?? null,
      input.passwordHash ?? null, input.platformRole ?? null, input.status ?? "active"]);
    return mapUser(requiredRow(result));
  }

  private async getUser(db: Queryable, id: UserId): Promise<ControlUser | null> {
    const result = await db.query<UserRow>(`${USER_SELECT} WHERE id=$1`, [id]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  private async findUserByUsername(db: Queryable, username: string, credentials: false): Promise<ControlUser | null>;
  private async findUserByUsername(db: Queryable, username: string, credentials: true): Promise<ControlUserWithCredentials | null>;
  private async findUserByUsername(db: Queryable, username: string, credentials: boolean): Promise<ControlUserWithCredentials | ControlUser | null> {
    const columns = credentials ? `${USER_COLUMNS}, password_hash` : USER_COLUMNS;
    const result = await db.query<UserCredentialRow>(`SELECT ${columns} FROM control_users WHERE username=$1 AND type='human'`, [username]);
    const row = result.rows[0];
    if (!row) return null;
    const user = mapUser(row);
    return credentials ? { ...user, passwordHash: row.password_hash } : user;
  }

  private async listTenantPage(input: Parameters<TenantDirectory["listPage"]>[0] = {}) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.status) clauses.push(`status=$${push(params, input.status)}`);
    if (input.query?.trim()) clauses.push(`(id ILIKE $${push(params, `%${input.query.trim()}%`)} OR display_name ILIKE $${params.length})`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = await this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM control_tenants ${where}`, params);
    const limit = pageSize(input.limit);
    const offset = pageOffset(input.offset);
    const rows = await this.pool.query<TenantRow>(`${TENANT_SELECT} ${where} ORDER BY created_at DESC, id LIMIT $${push(params, limit)} OFFSET $${push(params, offset)}`, params);
    return { items: rows.rows.map(mapTenant), total: Number(count.rows[0]?.count ?? 0), limit, offset };
  }

  private async listUserPage(input: Parameters<UserDirectory["listPage"]>[0] = {}) {
    const clauses = ["type='human'"];
    const params: unknown[] = [];
    if (input.status) clauses.push(`status=$${push(params, input.status)}`);
    if (input.platformRole !== undefined) clauses.push(input.platformRole === null ? "platform_role IS NULL" : `platform_role=$${push(params, input.platformRole)}`);
    if (input.query?.trim()) {
      const position = push(params, `%${input.query.trim()}%`);
      clauses.push(`(id ILIKE $${position} OR display_name ILIKE $${position} OR username ILIKE $${position})`);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const count = await this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM control_users ${where}`, params);
    const limit = pageSize(input.limit);
    const offset = pageOffset(input.offset);
    const rows = await this.pool.query<UserRow>(`${USER_SELECT} ${where} ORDER BY created_at DESC, id LIMIT $${push(params, limit)} OFFSET $${push(params, offset)}`, params);
    return { items: rows.rows.map(mapUser), total: Number(count.rows[0]?.count ?? 0), limit, offset };
  }

  private async getMembership(db: Queryable, userId: UserId, tenantId: TenantId): Promise<ControlMembership | null> {
    const result = await db.query<MembershipRow>(`${MEMBERSHIP_SELECT} WHERE m.user_id=$1 AND m.tenant_id=$2`, [userId, tenantId]);
    return result.rows[0] ? mapMembership(result.rows[0]) : null;
  }

  private async listMemberships(field: "tenant_id" | "user_id", id: string): Promise<ControlMembership[]> {
    const human = field === "tenant_id" ? " AND u.type='human'" : "";
    const result = await this.pool.query<MembershipRow>(`${MEMBERSHIP_SELECT} WHERE m.${field}=$1${human} ORDER BY m.${field === "tenant_id" ? "user_id" : "tenant_id"}`, [id]);
    return result.rows.map(mapMembership);
  }

  private async upsertMembership(db: Queryable, input: Omit<ControlMembership, "type">): Promise<ControlMembership> {
    await db.query("SELECT id FROM control_tenants WHERE id=$1 FOR UPDATE", [input.tenantId]);
    const existing = await this.getMembership(db, input.userId, input.tenantId);
    if (existing?.role === "owner" && input.role !== "owner" && await this.countOwners(db, input.tenantId) <= 1) {
      throw new HttpError(403, "forbidden", "不能降级租户唯一 owner");
    }
    await db.query(`
      INSERT INTO control_memberships(user_id, tenant_id, role) VALUES ($1, $2, $3)
      ON CONFLICT(user_id, tenant_id) DO UPDATE SET role=EXCLUDED.role
    `, [input.userId, input.tenantId, input.role]);
    const membership = await this.getMembership(db, input.userId, input.tenantId);
    if (!membership) throw new Error("membership upsert did not return a row");
    return membership;
  }

  private async deleteMembership(db: Queryable, userId: UserId, tenantId: TenantId): Promise<boolean> {
    await db.query("SELECT id FROM control_tenants WHERE id=$1 FOR UPDATE", [tenantId]);
    const existing = await this.getMembership(db, userId, tenantId);
    if (!existing) return false;
    if (existing.role === "owner" && await this.countOwners(db, tenantId) <= 1) {
      throw new HttpError(403, "forbidden", "不能移除租户唯一 owner");
    }
    return changed(await db.query("DELETE FROM control_memberships WHERE user_id=$1 AND tenant_id=$2", [userId, tenantId]));
  }

  private async countOwners(db: Queryable, tenantId: TenantId): Promise<number> {
    const result = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM control_memberships WHERE tenant_id=$1 AND role='owner'", [tenantId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  private async findFirstActiveForLogin(userId: UserId, allowPlatformFallback: boolean) {
    const result = await this.pool.query<{ tenant_id: string; role: string }>(`
      SELECT m.tenant_id, m.role FROM control_memberships m
      JOIN control_tenants t ON t.id=m.tenant_id
      WHERE m.user_id=$1 AND t.status='active' ORDER BY m.tenant_id LIMIT 1
    `, [userId]);
    const membership = result.rows[0];
    if (membership) return { tenantId: createTenantId(membership.tenant_id), role: TenantRoleSchema.parse(membership.role) };
    if (!allowPlatformFallback) return null;
    const fallback = await this.pool.query<{ id: string }>("SELECT id FROM control_tenants WHERE status='active' ORDER BY id LIMIT 1");
    return fallback.rows[0] ? { tenantId: createTenantId(fallback.rows[0].id), role: "member" as const } : null;
  }

  private async install(input: Parameters<ControlPlaneProvisioning["install"]>[0]): ReturnType<ControlPlaneProvisioning["install"]> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CONTROL_INSTALL_ADVISORY_LOCK_ID]);
      const installed = await client.query<{ value: string }>("SELECT value FROM control_system_settings WHERE key='installed'");
      if (installed.rows[0]?.value === "true") throw new HttpError(409, "already_installed", "系统已完成安装");
      const tenant = await this.getTenant(client, input.tenant.id) ?? await this.createTenant(client, input.tenant);
      let admin: ControlUser | undefined;
      let membership: ControlMembership | undefined;
      if (input.admin) {
        admin = await this.createUser(client, { ...input.admin, passwordHash: input.admin.passwordHash, platformRole: "admin" });
        membership = await this.upsertMembership(client, { userId: admin.id, tenantId: tenant.id, role: "owner" });
      }
      for (const [key, value] of Object.entries(input.settings)) await this.setSetting(client, key, value);
      await this.setSetting(client, "installed", "true");
      return { tenant, ...(admin ? { admin } : {}), ...(membership ? { membership } : {}) };
    });
  }

  private async createTenantWithOwner(input: Parameters<ControlPlaneProvisioning["createTenantWithOwner"]>[0]): ReturnType<ControlPlaneProvisioning["createTenantWithOwner"]> {
    return this.transaction(async (client) => {
      const tenant = await this.createTenant(client, input.tenant);
      const membership = await this.upsertMembership(client, { userId: input.ownerUserId, tenantId: tenant.id, role: "owner" });
      return { tenant, membership };
    });
  }

  private async inviteOrAttachMember(input: Parameters<ControlPlaneProvisioning["inviteOrAttachMember"]>[0]): ReturnType<ControlPlaneProvisioning["inviteOrAttachMember"]> {
    return this.transaction(async (client) => {
      const existing = await this.findUserByUsername(client, input.username, false);
      const user = existing ?? await this.createUser(client, {
        id: input.userId,
        displayName: input.displayName,
        username: input.username,
        passwordHash: input.passwordHash,
      });
      const membership = await this.upsertMembership(client, { userId: user.id, tenantId: input.tenantId, role: input.role });
      return { user, membership, created: existing === null };
    });
  }

  private async ensureLocalIdentity(input: Parameters<ControlPlaneProvisioning["ensureLocalIdentity"]>[0]): ReturnType<ControlPlaneProvisioning["ensureLocalIdentity"]> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CONTROL_INSTALL_ADVISORY_LOCK_ID]);
      await client.query(`
        INSERT INTO control_tenants(id, display_name, status) VALUES ($1, $2, 'active')
        ON CONFLICT(id) DO UPDATE SET status='active'
      `, [input.tenant.id, input.tenant.displayName]);
      await client.query(`
        INSERT INTO control_users(id, display_name, platform_role, status, type, owner_id)
        VALUES ($1, $2, $3, 'active', 'human', NULL)
        ON CONFLICT(id) DO UPDATE SET platform_role=EXCLUDED.platform_role, status='active'
      `, [input.user.id, input.user.displayName, input.user.platformRole]);
      const tenant = await this.getTenant(client, input.tenant.id);
      const user = await this.getUser(client, input.user.id);
      if (!tenant || !user) throw new Error("local identity upsert did not return rows");
      const membership = await this.upsertMembership(client, { userId: user.id, tenantId: tenant.id, role: input.role });
      return { tenant, user, membership };
    });
  }

  private async setUserStatus(db: Queryable, userId: UserId, status: "active" | "disabled"): Promise<boolean> {
    if (status === "disabled") {
      await db.query("SELECT pg_advisory_xact_lock($1)", [CONTROL_ADMIN_ADVISORY_LOCK_ID]);
      const user = await this.getUser(db, userId);
      if (!user) return false;
      if (user.status === "active" && user.platformRole === "admin") await this.assertAnotherActiveAdmin(db, userId);
    }
    return changed(await db.query("UPDATE control_users SET status=$1 WHERE id=$2", [status, userId]));
  }

  private async setUserPlatformRole(db: Queryable, userId: UserId, role: "admin" | null): Promise<boolean> {
    await db.query("SELECT pg_advisory_xact_lock($1)", [CONTROL_ADMIN_ADVISORY_LOCK_ID]);
    const user = await this.getUser(db, userId);
    if (!user) return false;
    if (role === null && user.platformRole === "admin" && user.status === "active") await this.assertAnotherActiveAdmin(db, userId);
    return changed(await db.query("UPDATE control_users SET platform_role=$1 WHERE id=$2", [role, userId]));
  }

  private async assertAnotherActiveAdmin(db: Queryable, excludedUserId: UserId): Promise<void> {
    const result = await db.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM control_users
      WHERE platform_role='admin' AND status='active' AND id<>$1
    `, [excludedUserId]);
    if (Number(result.rows[0]?.count ?? 0) < 1) throw new HttpError(409, "last_platform_admin", "至少需要保留一个 active 平台管理员");
  }

  private async setSetting(db: Queryable, key: string, value: string): Promise<void> {
    await db.query(`
      INSERT INTO control_system_settings(key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at
    `, [key, value]);
  }

  private async recordAudit(db: Queryable, input: Parameters<ControlPlane["audit"]["record"]>[0]): Promise<void> {
    await db.query(`
      INSERT INTO control_platform_audit(actor_user_id, action, target_tenant_id, target_resource, detail_json)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [input.actorUserId, input.action, input.targetTenantId ?? null, input.targetResource,
      input.detail === undefined ? null : JSON.stringify(input.detail)]);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        if (error instanceof Error) error.cause ??= rollbackError;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface CreatePostgresControlPlaneAdapterOptions {
  connectionString?: string;
  pool?: Pool;
  poolMax?: number;
  runMigrations?: boolean;
}

export async function createPostgresControlPlaneAdapter(
  options: CreatePostgresControlPlaneAdapterOptions,
): Promise<PostgresControlPlaneAdapter> {
  const ownsPool = options.pool === undefined;
  if (!options.pool && !options.connectionString) {
    throw new Error("Postgres Control Plane requires connectionString when pool is not supplied");
  }
  const pool = options.pool ?? new Pool({ connectionString: options.connectionString, max: options.poolMax ?? 10 });
  try {
    if (options.runMigrations !== false) await runPostgresControlMigrations(pool);
    return new PostgresControlPlaneAdapter(pool, { ownsPool });
  } catch (error) {
    if (ownsPool) await pool.end().catch(() => undefined);
    throw error;
  }
}

const TENANT_SELECT = "SELECT id, display_name, created_at, status FROM control_tenants";
const USER_COLUMNS = "id, display_name, created_at, username, platform_role, status, type, owner_id";
const USER_SELECT = `SELECT ${USER_COLUMNS} FROM control_users`;
const MEMBERSHIP_SELECT = `SELECT m.user_id, m.tenant_id, m.role, u.type
  FROM control_memberships m JOIN control_users u ON u.id=m.user_id`;

interface TenantRow extends QueryResultRow { id: string; display_name: string; created_at: Date | string; status: string }
interface UserRow extends QueryResultRow { id: string; display_name: string; created_at: Date | string; username: string | null; platform_role: string | null; status: string; type: string; owner_id: string | null }
interface UserCredentialRow extends UserRow { password_hash: string | null }
interface MembershipRow extends QueryResultRow { user_id: string; tenant_id: string; role: string; type: string }

function mapTenant(row: TenantRow): ControlTenant {
  return { id: createTenantId(row.id), displayName: row.display_name, createdAt: timestamp(row.created_at), status: row.status === "suspended" ? "suspended" : "active" };
}

function mapUser(row: UserRow): ControlUser {
  const platformRole = row.platform_role === "admin" ? "admin" as const : undefined;
  return {
    id: createUserId(row.id),
    displayName: row.display_name,
    createdAt: timestamp(row.created_at),
    ...(row.username === null ? {} : { username: row.username }),
    ...(platformRole ? { platformRole } : {}),
    status: row.status === "disabled" ? "disabled" : "active",
    type: UserTypeSchema.parse(row.type),
    owner_id: row.owner_id === null ? null : createUserId(row.owner_id),
  };
}

function mapMembership(row: MembershipRow): ControlMembership {
  return { userId: createUserId(row.user_id), tenantId: createTenantId(row.tenant_id), role: TenantRoleSchema.parse(row.role), type: UserTypeSchema.parse(row.type) };
}

function changed(result: QueryResult): boolean { return rowCount(result) > 0; }
function rowCount(result: QueryResult): number { return result.rowCount ?? 0; }
function requiredRow<Row extends QueryResultRow>(result: QueryResult<Row>): Row {
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL control write did not return a row");
  return row;
}
function timestamp(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function pageSize(value: number | undefined): number { return Math.min(200, Math.max(1, Number.isFinite(value) ? Math.trunc(value as number) : 20)); }
function pageOffset(value: number | undefined): number { return Math.max(0, Number.isFinite(value) ? Math.trunc(value as number) : 0); }
function push(params: unknown[], value: unknown): number { params.push(value); return params.length; }
