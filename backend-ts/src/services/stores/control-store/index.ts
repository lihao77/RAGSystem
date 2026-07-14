import type { TenantId, UserId } from "../../../identity/types.js";
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

export interface ControlMembership {
  userId: UserId;
  tenantId: TenantId;
  role: string;
}

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
    this.db.prepare("INSERT INTO users(id, display_name, created_at, username, password_hash, platform_role, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.displayName, createdAt, input.username ?? null, input.password_hash ?? null, platformRole, status);
    return {
      id: input.id,
      displayName: input.displayName,
      createdAt,
      ...(input.username ? { username: input.username } : {}),
      ...(platformRole ? { platformRole } : {}),
      status,
    };
  }

  getUser(id: UserId): ControlUser | null {
    const row = this.db.prepare("SELECT id, display_name, created_at, username, platform_role, status FROM users WHERE id=?").get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  getUserByUsername(username: string): ControlUser | null {
    const row = this.db.prepare("SELECT id, display_name, created_at, username, platform_role, status FROM users WHERE username=?").get(username) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  getUserWithCredentials(id: UserId): ControlUserWithCredentials | null {
    const row = this.db.prepare("SELECT id, display_name, created_at, username, password_hash, platform_role, status FROM users WHERE id=?").get(id) as UserCredentialRow | undefined;
    return row ? { ...mapUser(row), passwordHash: row.password_hash } : null;
  }

  listUsers(): ControlUser[] {
    const rows = this.db.prepare("SELECT id, display_name, created_at, username, platform_role, status FROM users ORDER BY created_at, id").all() as unknown as UserRow[];
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
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.status) {
      clauses.push("status=?");
      params.push(assertUserStatus(input.status));
    }
    if (input.platformRole !== undefined) {
      const platformRole = assertPlatformRole(input.platformRole);
      clauses.push(platformRole ? "platform_role=?" : "platform_role IS NULL");
      if (platformRole) params.push(platformRole);
    }
    if (input.query?.trim()) {
      clauses.push("(id LIKE ? OR display_name LIKE ? OR username LIKE ?)");
      const pattern = `%${input.query.trim()}%`;
      params.push(pattern, pattern, pattern);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(...params) as { count: number | bigint };
    const rows = this.db.prepare(`SELECT id, display_name, created_at, username, platform_role, status FROM users ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
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

  upsertMembership(input: ControlMembership): ControlMembership {
    return this.inImmediateTransaction(() => {
      const existing = this.getMembership(input.userId, input.tenantId);
      if (existing?.role === "owner" && input.role !== "owner" && this.countOwners(input.tenantId) <= 1) {
        throw new HttpError(403, "forbidden", "不能降级租户唯一 owner");
      }
      this.db.prepare(`
        INSERT INTO memberships(user_id, tenant_id, role) VALUES (?, ?, ?)
        ON CONFLICT(user_id, tenant_id) DO UPDATE SET role=excluded.role
      `).run(input.userId, input.tenantId, input.role);
      return input;
    });
  }

  getMembership(userId: UserId, tenantId: TenantId): ControlMembership | null {
    const row = this.db.prepare("SELECT user_id, tenant_id, role FROM memberships WHERE user_id=? AND tenant_id=?")
      .get(userId, tenantId) as MembershipRow | undefined;
    return row ? mapMembership(row) : null;
  }

  listMembershipsByTenant(tenantId: TenantId): ControlMembership[] {
    const rows = this.db.prepare("SELECT user_id, tenant_id, role FROM memberships WHERE tenant_id=? ORDER BY user_id")
      .all(tenantId) as unknown as MembershipRow[];
    return rows.map(mapMembership);
  }

  listMembershipsByUser(userId: UserId): ControlMembership[] {
    const rows = this.db.prepare("SELECT user_id, tenant_id, role FROM memberships WHERE user_id=? ORDER BY tenant_id")
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

interface TenantRow { id: TenantId; display_name: string; created_at: string; status: string; }
interface UserRow { id: UserId; display_name: string; created_at: string; username: string | null; platform_role: string | null; status: string; }
interface UserCredentialRow extends UserRow { password_hash: string | null; }
interface MembershipRow { user_id: UserId; tenant_id: TenantId; role: string; }

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
  };
}
function mapMembership(row: MembershipRow): ControlMembership { return { userId: row.user_id, tenantId: row.tenant_id, role: row.role }; }

function assertPlatformRole(value: unknown): PlatformRole | null {
  if (value === null || value === undefined) return null;
  if (value !== "admin") throw new Error(`未知平台角色: ${String(value)}`);
  return value;
}

function assertUserStatus(value: unknown): UserStatus {
  if (value !== "active" && value !== "disabled") throw new Error(`未知用户状态: ${String(value)}`);
  return value;
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
