import type { TenantId, UserId } from "../../../identity/types.js";
import { HttpError } from "../../../utils/errors.js";
import { createControlDb, type ControlDb } from "./db.js";

export interface ControlTenant {
  id: TenantId;
  displayName: string;
  createdAt: string;
}

export interface ControlUser {
  id: UserId;
  displayName: string;
  createdAt: string;
  username?: string;
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

  createTenant(input: { id: TenantId; displayName: string; createdAt?: string }): ControlTenant {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.prepare("INSERT INTO tenants(id, display_name, created_at) VALUES (?, ?, ?)")
      .run(input.id, input.displayName, createdAt);
    return { id: input.id, displayName: input.displayName, createdAt };
  }

  getTenant(id: TenantId): ControlTenant | null {
    const row = this.db.prepare("SELECT id, display_name, created_at FROM tenants WHERE id=?").get(id) as TenantRow | undefined;
    return row ? mapTenant(row) : null;
  }

  listTenants(): ControlTenant[] {
    const rows = this.db.prepare("SELECT id, display_name, created_at FROM tenants ORDER BY created_at, id").all() as unknown as TenantRow[];
    return rows.map(mapTenant);
  }

  updateTenant(id: TenantId, displayName: string): boolean {
    return Number(this.db.prepare("UPDATE tenants SET display_name=? WHERE id=?").run(displayName, id).changes) > 0;
  }

  deleteTenant(id: TenantId): boolean {
    return Number(this.db.prepare("DELETE FROM tenants WHERE id=?").run(id).changes) > 0;
  }

  createUser(input: { id: UserId; displayName: string; createdAt?: string; username?: string; password_hash?: string }): ControlUser {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.prepare("INSERT INTO users(id, display_name, created_at, username, password_hash) VALUES (?, ?, ?, ?, ?)")
      .run(input.id, input.displayName, createdAt, input.username ?? null, input.password_hash ?? null);
    return { id: input.id, displayName: input.displayName, createdAt, ...(input.username ? { username: input.username } : {}) };
  }

  getUser(id: UserId): ControlUser | null {
    const row = this.db.prepare("SELECT id, display_name, created_at, username FROM users WHERE id=?").get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  getUserByUsername(username: string): ControlUser | null {
    const row = this.db.prepare("SELECT id, display_name, created_at, username FROM users WHERE username=?").get(username) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  getUserWithCredentials(id: UserId): ControlUserWithCredentials | null {
    const row = this.db.prepare("SELECT id, display_name, created_at, username, password_hash FROM users WHERE id=?").get(id) as UserCredentialRow | undefined;
    return row ? { ...mapUser(row), passwordHash: row.password_hash } : null;
  }

  listUsers(): ControlUser[] {
    const rows = this.db.prepare("SELECT id, display_name, created_at, username FROM users ORDER BY created_at, id").all() as unknown as UserRow[];
    return rows.map(mapUser);
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

interface TenantRow { id: TenantId; display_name: string; created_at: string; }
interface UserRow { id: UserId; display_name: string; created_at: string; username: string | null; }
interface UserCredentialRow extends UserRow { password_hash: string | null; }
interface MembershipRow { user_id: UserId; tenant_id: TenantId; role: string; }

function mapTenant(row: TenantRow): ControlTenant { return { id: row.id, displayName: row.display_name, createdAt: row.created_at }; }
function mapUser(row: UserRow): ControlUser {
  return { id: row.id, displayName: row.display_name, createdAt: row.created_at, ...(row.username ? { username: row.username } : {}) };
}
function mapMembership(row: MembershipRow): ControlMembership { return { userId: row.user_id, tenantId: row.tenant_id, role: row.role }; }

export { CONTROL_LATEST_SCHEMA_VERSION } from "./migrations.js";
