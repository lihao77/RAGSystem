const TENANT_ID_PATTERN = /^tnt_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const USER_ID_PATTERN = /^usr_[a-z0-9]+(?:_[a-z0-9]+)*$/;

export type TenantId = string & { readonly __brand: "TenantId" };
export type UserId = string & { readonly __brand: "UserId" };

export type DeploymentMode = "local";
export type AuthMode = "local";
export type TenancyMode = "single" | "multi";
export type ExecutionMode = "local";
export type StorageMode = "sqlite" | "sqlite-per-tenant";
export type UiMode = "local";

export interface DeploymentProfile {
  deployment: DeploymentMode;
  auth: AuthMode;
  tenancy: TenancyMode;
  execution: ExecutionMode;
  storage: StorageMode;
  ui: UiMode;
}

export interface RequestIdentity {
  userId: UserId;
  tenantId: TenantId;
  role: string;
  permissions: string[];
  platformRole?: "admin";
  /** External transport principal bound to an exact persisted session origin. */
  originPrincipal?: { type: string; id: string };
}

export function createTenantId(value: string): TenantId {
  const normalized = value.trim();
  if (!TENANT_ID_PATTERN.test(normalized)) {
    throw new Error(`无效租户 ID: ${value}`);
  }
  return normalized as TenantId;
}

export function createUserId(value: string): UserId {
  const normalized = value.trim();
  if (!USER_ID_PATTERN.test(normalized)) {
    throw new Error(`无效用户 ID: ${value}`);
  }
  return normalized as UserId;
}

export function isTenantId(value: string): value is TenantId {
  return TENANT_ID_PATTERN.test(value);
}

export function isUserId(value: string): value is UserId {
  return USER_ID_PATTERN.test(value);
}
