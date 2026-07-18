import type { TenantId } from "../identity/types.js";

export interface WidgetAppCredential {
  app_key: string;
  tenant_id: TenantId;
  secret_hash: string;
  secret_prefix: string;
  display_name: string;
  allowed_origins: string;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatedWidgetAppCredential {
  app_key: string;
  tenant_id: TenantId;
  secret: string;
  secret_prefix: string;
  display_name: string;
  allowed_origins: string[];
}

export interface WidgetSessionToken {
  jti: string;
  app_key: string;
  issued_at: number;
  expires_at: number;
  revoked: boolean;
}

export interface WidgetAuditEntry {
  id: number;
  app_key: string;
  action: string;
  actor: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface WidgetAppCredentialRepository {
  create(input: { tenantId: TenantId; display_name: string; allowed_origins?: string[] }): Promise<CreatedWidgetAppCredential>;
  resolveTenantId(appKey: string): Promise<TenantId | null>;
  verifySecret(tenantId: TenantId, appKey: string, secret: string): Promise<WidgetAppCredential | null>;
  get(tenantId: TenantId, appKey: string): Promise<WidgetAppCredential | null>;
  list(tenantId: TenantId): Promise<WidgetAppCredential[]>;
  update(tenantId: TenantId, appKey: string, input: { display_name?: string; allowed_origins?: string[] }): Promise<WidgetAppCredential | null>;
  rotateSecret(tenantId: TenantId, appKey: string): Promise<CreatedWidgetAppCredential | null>;
  revoke(tenantId: TenantId, appKey: string): Promise<boolean>;
  listAllowedOrigins(tenantId: TenantId): Promise<string[]>;
}

export interface WidgetSessionTokenRepository {
  record(input: { tenantId: TenantId; jti: string; app_key: string; issued_at: number; expires_at: number }): Promise<void>;
  isRevoked(tenantId: TenantId, jti: string): Promise<boolean>;
  revoke(tenantId: TenantId, jti: string): Promise<boolean>;
  listByApp(tenantId: TenantId, appKey: string): Promise<WidgetSessionToken[]>;
  pruneExpired(nowSeconds: number): Promise<number>;
}

export interface WidgetAuditRepository {
  record(tenantId: TenantId, input: { app_key: string; action: string; actor: string; detail?: Record<string, unknown> }): Promise<void>;
  list(tenantId: TenantId, appKey: string, limit?: number, offset?: number): Promise<WidgetAuditEntry[]>;
}

export interface WidgetCredentialRepository {
  readonly apps: WidgetAppCredentialRepository;
  readonly tokens: WidgetSessionTokenRepository;
  readonly audit: WidgetAuditRepository;
  startPruning(intervalMs?: number): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
