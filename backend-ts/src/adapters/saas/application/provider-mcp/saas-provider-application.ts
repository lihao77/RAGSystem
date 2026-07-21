import type { ProviderApplication } from "../../../../contracts/application/provider-application.js";
import type {
  McpServerRecord,
  ProviderConfigRecord,
  ProviderMcpRepository,
} from "../../../../contracts/integrations/provider-mcp-repository.js";
import type {
  ModelProviderConfig,
  ProviderPayload,
  TestProviderRequest,
} from "../../../../contracts/integrations/model-adapter.js";
import type { TenantId } from "../../../../identity/types.js";
import {
  ModelAdapterService,
  ModelAdapterServiceError,
} from "../../../../services/integrations/model-adapter-service.js";
import { toModelProviderConfig } from "./provider-config-mapping.js";

/**
 * Tenant-bound provider application.
 * PostgreSQL is the sole source of truth; ModelAdapterService is only the in-process projection + validation.
 */
export class SaaSProviderApplication implements ProviderApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly service: ModelAdapterService,
    private readonly repository: ProviderMcpRepository,
  ) {}

  listProviderTypes() {
    return this.service.listProviderTypes();
  }

  async listProviders(): Promise<ModelProviderConfig[]> {
    const records = await this.repository.listProviders(this.tenantId);
    return records.map(toModelProviderConfig);
  }

  async createProvider(payload: ProviderPayload): Promise<string> {
    const { key, config } = this.service.buildCreateProvider(payload);
    if (await this.repository.getProvider(this.tenantId, key)) {
      throw new ModelAdapterServiceError(`Provider 已存在: ${key}`, 409);
    }
    await this.repository.upsertProvider(this.tenantId, key, config as unknown as Record<string, unknown>);
    await this.hydrateRuntimeFromRepository();
    return key;
  }

  async reorderProviders(providerKeys: string[]): Promise<string[]> {
    // Align runtime with the store before validating the full key set.
    await this.hydrateRuntimeFromRepository();
    const keys = this.service.buildReorderProviders(providerKeys);
    if (!await this.repository.reorderProviders(this.tenantId, keys)) {
      throw new ModelAdapterServiceError("Provider 顺序更新失败", 400);
    }
    await this.hydrateRuntimeFromRepository();
    return keys;
  }

  async updateProvider(providerKey: string, payload: ProviderPayload): Promise<string> {
    const existingRecord = await this.repository.getProvider(this.tenantId, providerKey);
    if (!existingRecord) {
      throw new ModelAdapterServiceError(`Provider 不存在: ${providerKey}`, 404);
    }
    const existing = toModelProviderConfig(existingRecord);
    const { key, config } = this.service.buildUpdateProvider(providerKey, existing, payload);
    await this.repository.upsertProvider(this.tenantId, key, config as unknown as Record<string, unknown>);
    await this.hydrateRuntimeFromRepository();
    return key;
  }

  async deleteProvider(providerKey: string): Promise<void> {
    if (!await this.repository.deleteProvider(this.tenantId, providerKey)) {
      throw new ModelAdapterServiceError(`Provider 不存在: ${providerKey}`, 404);
    }
    await this.hydrateRuntimeFromRepository();
  }

  checkProviderAvailability(providerKey: string) {
    return this.service.checkProviderAvailability(providerKey);
  }

  getProviderMetrics(providerKey: string) {
    return this.service.getProviderMetrics(providerKey);
  }

  testProvider(payload: TestProviderRequest) {
    return this.service.testProvider(payload);
  }

  private async hydrateRuntimeFromRepository(): Promise<void> {
    const records = await this.repository.listProviders(this.tenantId);
    this.service.replaceRuntimeProviders(records.map(toModelProviderConfig));
  }
}

// Re-export record types used by tests that import this module's helpers historically.
export type { ProviderConfigRecord, McpServerRecord };
