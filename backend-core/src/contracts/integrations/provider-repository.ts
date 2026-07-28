import type { TenantId } from "../../identity/types.js";
import type { SecretResolver } from "./secret-resolver.js";

export interface ProviderConfigRecord {
  tenant_id: TenantId;
  provider_key: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProviderRepository {
  listProviders(tenantId: TenantId): Promise<ProviderConfigRecord[]>;
  getProvider(tenantId: TenantId, key: string): Promise<ProviderConfigRecord | null>;
  upsertProvider(tenantId: TenantId, key: string, config: Record<string, unknown>): Promise<ProviderConfigRecord>;
  deleteProvider(tenantId: TenantId, key: string): Promise<boolean>;
  reorderProviders(tenantId: TenantId, keys: string[]): Promise<boolean>;
}

export type ProviderSecretResolver = SecretResolver;
