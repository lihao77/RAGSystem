import type { Membership, UserType } from "../user.js";
import type { TenantId, UserId } from "../../identity/types.js";

export type PlatformRole = "admin";
export type UserStatus = "active" | "disabled";
export type TenantStatus = "active" | "suspended";

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

export interface ControlUserWithCredentials extends ControlUser {
  passwordHash: string | null;
}

export type ControlMembership = Membership;

export interface PaginatedControlResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface LoginTenantSelection {
  tenantId: TenantId;
  role: ControlMembership["role"];
}

export interface ControlPlaneReadiness {
  ready: boolean;
  currentSchemaVersion: number;
  latestSchemaVersion: number;
}
