import type { TenantId, UserId } from "../../../identity/types.js";
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

  createUser(input: { id: UserId; displayName: string; createdAt?: string }): ControlUser {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.prepare("INSERT INTO users(id, display_name, created_at) VALUES (?, ?, ?)")
      .run(input.id, input.displayName, createdAt);
    return { id: input.id, displayName: input.displayName, createdAt };
  }

  getUser(id: UserId): ControlUser | null {
    const row = this.db.prepare("SELECT id, display_name, created_at FROM users WHERE id=?").get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  listUsers(): ControlUser[] {
    const rows = this.db.prepare("SELECT id, display_name, created_at FROM users ORDER BY created_at, id").all() as unknown as UserRow[];
    return rows.map(mapUser);
  }

  updateUser(id: UserId, displayName: string): boolean {
    return Number(this.db.prepare("UPDATE users SET display_name=? WHERE id=?").run(displayName, id).changes) > 0;
  }

  deleteUser(id: UserId): boolean {
    return Number(this.db.prepare("DELETE FROM users WHERE id=?").run(id).changes) > 0;
  }

  upsertMembership(input: ControlMembership): ControlMembership {
    this.db.prepare(`
      INSERT INTO memberships(user_id, tenant_id, role) VALUES (?, ?, ?)
      ON CONFLICT(user_id, tenant_id) DO UPDATE SET role=excluded.role
    `).run(input.userId, input.tenantId, input.role);
    return input;
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

  deleteMembership(userId: UserId, tenantId: TenantId): boolean {
    return Number(this.db.prepare("DELETE FROM memberships WHERE user_id=? AND tenant_id=?").run(userId, tenantId).changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

export function createControlStore(systemRoot: string): ControlStore {
  return new ControlStore(createControlDb(systemRoot));
}

interface TenantRow { id: TenantId; display_name: string; created_at: string; }
interface UserRow { id: UserId; display_name: string; created_at: string; }
interface MembershipRow { user_id: UserId; tenant_id: TenantId; role: string; }

function mapTenant(row: TenantRow): ControlTenant { return { id: row.id, displayName: row.display_name, createdAt: row.created_at }; }
function mapUser(row: UserRow): ControlUser { return { id: row.id, displayName: row.display_name, createdAt: row.created_at }; }
function mapMembership(row: MembershipRow): ControlMembership { return { userId: row.user_id, tenantId: row.tenant_id, role: row.role }; }

export { CONTROL_LATEST_SCHEMA_VERSION } from "./migrations.js";
