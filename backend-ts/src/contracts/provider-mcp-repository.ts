import type { TenantId } from "../identity/types.js";
import type { SecretResolver } from "./integrations/secret-resolver.js";

export interface ProviderConfigRecord {
  tenant_id: TenantId;
  provider_key: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface McpServerRecord {
  tenant_id: TenantId;
  server_name: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProviderMcpRepository {
  listProviders(tenantId: TenantId): Promise<ProviderConfigRecord[]>;
  getProvider(tenantId: TenantId, key: string): Promise<ProviderConfigRecord | null>;
  upsertProvider(tenantId: TenantId, key: string, config: Record<string, unknown>): Promise<ProviderConfigRecord>;
  deleteProvider(tenantId: TenantId, key: string): Promise<boolean>;
  reorderProviders(tenantId: TenantId, keys: string[]): Promise<boolean>;
  listMcpServers(tenantId: TenantId): Promise<McpServerRecord[]>;
  getMcpServer(tenantId: TenantId, name: string): Promise<McpServerRecord | null>;
  upsertMcpServer(tenantId: TenantId, name: string, config: Record<string, unknown>): Promise<McpServerRecord>;
  deleteMcpServer(tenantId: TenantId, name: string): Promise<boolean>;
}

export type ProviderMcpSecretResolver = SecretResolver;
