import type { ProviderApplication } from "../../../../contracts/application/provider-application.js";
import type { ProviderMcpRepository } from "../../../../contracts/integrations/provider-mcp-repository.js";
import type { ProviderPayload, TestProviderRequest } from "../../../../contracts/integrations/model-adapter.js";
import type { TenantId } from "../../../../identity/types.js";
import type { ModelAdapterService } from "../../../../services/integrations/model-adapter-service.js";

/** Tenant-bound provider application. PostgreSQL is used only for persistence; validation and runtime behavior stay in ModelAdapterService. */
export class SaaSProviderApplication implements ProviderApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly service: ModelAdapterService,
    private readonly repository: ProviderMcpRepository,
  ) {}

  listProviderTypes() { return this.service.listProviderTypes(); }
  listProviders() { return this.service.listProviders(); }

  async createProvider(payload: ProviderPayload): Promise<string> {
    const snapshot = this.service.listProviders();
    try {
      const key = this.service.createProvider(payload);
      const provider = this.service.getProvider(key);
      if (!provider) throw new Error(`Provider 不存在: ${key}`);
      await this.repository.upsertProvider(this.tenantId, key, provider as Record<string, unknown>);
      return key;
    } catch (error) {
      this.service.replaceRuntimeProviders(snapshot);
      throw error;
    }
  }

  async reorderProviders(providerKeys: string[]): Promise<string[]> {
    const snapshot = this.service.listProviders();
    try {
      const keys = this.service.reorderProviders({ provider_keys: providerKeys });
      if (!await this.repository.reorderProviders(this.tenantId, keys)) throw new Error("Provider 顺序更新失败");
      return keys;
    } catch (error) {
      this.service.replaceRuntimeProviders(snapshot);
      throw error;
    }
  }

  async updateProvider(providerKey: string, payload: ProviderPayload): Promise<string> {
    const snapshot = this.service.listProviders();
    try {
      const key = this.service.updateProvider(providerKey, payload);
      const provider = this.service.getProvider(key);
      if (!provider) throw new Error(`Provider 不存在: ${key}`);
      await this.repository.upsertProvider(this.tenantId, key, provider as Record<string, unknown>);
      return key;
    } catch (error) {
      this.service.replaceRuntimeProviders(snapshot);
      throw error;
    }
  }

  async deleteProvider(providerKey: string): Promise<void> {
    const snapshot = this.service.listProviders();
    try {
      this.service.deleteProvider(providerKey);
      if (!await this.repository.deleteProvider(this.tenantId, providerKey)) throw new Error(`Provider 不存在: ${providerKey}`);
    } catch (error) {
      this.service.replaceRuntimeProviders(snapshot);
      throw error;
    }
  }

  checkProviderAvailability(providerKey: string) { return this.service.checkProviderAvailability(providerKey); }
  getProviderMetrics(providerKey: string) { return this.service.getProviderMetrics(providerKey); }
  testProvider(payload: TestProviderRequest) { return this.service.testProvider(payload); }
}
