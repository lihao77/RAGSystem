import type { TenantId, UserId } from "../../identity/types.js";
import type {
  ControlMembership,
  ControlPlaneReadiness,
  ControlTenant,
  ControlUser,
  ControlUserWithCredentials,
  LoginTenantSelection,
  PaginatedControlResult,
  PlatformRole,
  TenantStatus,
  UserStatus,
} from "./types.js";

export interface TenantDirectory {
  create(input: { id: TenantId; displayName: string; createdAt?: string; status?: TenantStatus }): Promise<ControlTenant>;
  get(id: TenantId): Promise<ControlTenant | null>;
  list(): Promise<ControlTenant[]>;
  listPage(input?: { limit?: number; offset?: number; status?: TenantStatus; query?: string }): Promise<PaginatedControlResult<ControlTenant>>;
  updateName(id: TenantId, displayName: string): Promise<boolean>;
  setStatus(id: TenantId, status: TenantStatus): Promise<boolean>;
  delete(id: TenantId): Promise<boolean>;
}

export interface UserDirectory {
  create(input: {
    id: UserId;
    displayName: string;
    createdAt?: string;
    username?: string;
    passwordHash?: string;
    platformRole?: PlatformRole | null;
    status?: UserStatus;
  }): Promise<ControlUser>;
  get(id: UserId): Promise<ControlUser | null>;
  findByUsername(username: string): Promise<ControlUser | null>;
  findCredentialsByUsername(username: string): Promise<ControlUserWithCredentials | null>;
  list(): Promise<ControlUser[]>;
  listPage(input?: { limit?: number; offset?: number; status?: UserStatus; platformRole?: PlatformRole | null; query?: string }): Promise<PaginatedControlResult<ControlUser>>;
  updateName(id: UserId, displayName: string): Promise<boolean>;
  setStatus(id: UserId, status: UserStatus): Promise<boolean>;
  setPlatformRole(id: UserId, platformRole: PlatformRole | null): Promise<boolean>;
  delete(id: UserId): Promise<boolean>;
}

export interface MembershipDirectory {
  upsert(input: Omit<ControlMembership, "type">): Promise<ControlMembership>;
  get(userId: UserId, tenantId: TenantId): Promise<ControlMembership | null>;
  listByTenant(tenantId: TenantId): Promise<ControlMembership[]>;
  listByUser(userId: UserId): Promise<ControlMembership[]>;
  delete(userId: UserId, tenantId: TenantId): Promise<boolean>;
  findFirstActiveForLogin(userId: UserId, allowPlatformFallback: boolean): Promise<LoginTenantSelection | null>;
}

export interface ControlSettingsRepository {
  get(key: string): Promise<string | null>;
  getAll(): Promise<Record<string, string>>;
  set(key: string, value: string): Promise<void>;
  setMany(settings: Readonly<Record<string, string>>): Promise<void>;
}

export interface AuthSessionRepository {
  record(input: { jti: string; userId: UserId; tenantId: TenantId; issuedAt: number; expiresAt: number }): Promise<void>;
  isRevoked(tenantId: TenantId, jti: string): Promise<boolean>;
  revoke(jti: string): Promise<boolean>;
  pruneExpired(now?: number): Promise<number>;
}

export interface ControlAuditRepository {
  record(input: { actorUserId: UserId; action: string; targetTenantId?: TenantId; targetResource: string; detail?: Record<string, unknown> }): Promise<void>;
}

export interface ControlPlaneHealth {
  checkReadiness(): Promise<ControlPlaneReadiness>;
}

export interface ControlPlaneProvisioning {
  install(input: {
    tenant: { id: TenantId; displayName: string; createdAt?: string };
    admin?: { id: UserId; displayName: string; username: string; passwordHash: string };
    settings: Readonly<Record<string, string>>;
  }): Promise<{ tenant: ControlTenant; admin?: ControlUser; membership?: ControlMembership }>;
  createTenantWithOwner(input: { tenant: { id: TenantId; displayName: string; createdAt?: string }; ownerUserId: UserId }): Promise<{ tenant: ControlTenant; membership: ControlMembership }>;
  inviteOrAttachMember(input: { tenantId: TenantId; userId: UserId; username: string; passwordHash: string; displayName: string; role: ControlMembership["role"] }): Promise<{ user: ControlUser; membership: ControlMembership; created: boolean }>;
  removeMember(input: { tenantId: TenantId; userId: UserId }): Promise<boolean>;
  ensureLocalIdentity(input: {
    tenant: { id: TenantId; displayName: string };
    user: { id: UserId; displayName: string; platformRole: PlatformRole };
    role: ControlMembership["role"];
  }): Promise<{ tenant: ControlTenant; user: ControlUser; membership: ControlMembership }>;
}

export interface ControlPlaneCommands {
  setTenantStatus(input: { actorUserId: UserId; tenantId: TenantId; status: TenantStatus }): Promise<ControlTenant | null>;
  setUserStatus(input: { actorUserId: UserId; userId: UserId; status: UserStatus }): Promise<ControlUser | null>;
  setUserPlatformRole(input: { actorUserId: UserId; userId: UserId; platformRole: PlatformRole | null }): Promise<ControlUser | null>;
}

export interface ControlPlane {
  tenants: TenantDirectory;
  users: UserDirectory;
  memberships: MembershipDirectory;
  settings: ControlSettingsRepository;
  sessions: AuthSessionRepository;
  audit: ControlAuditRepository;
  health: ControlPlaneHealth;
  provisioning: ControlPlaneProvisioning;
  commands: ControlPlaneCommands;
  close(): Promise<void>;
}
