import type { ProviderApplication } from "../../../../contracts/application/provider-application.js";
import type { ProviderPayload, TestProviderRequest } from "../../../../contracts/integrations/model-adapter.js";
import type { ModelAdapterService } from "../../../../services/integrations/model-adapter-service.js";

export class LocalProviderApplication implements ProviderApplication {
  constructor(private readonly service: ModelAdapterService) {}

  async listProviderTypes() { return this.service.listProviderTypes(); }
  async listProviders() { return this.service.listProviders(); }
  async createProvider(payload: ProviderPayload) { return this.service.createProvider(payload); }
  async reorderProviders(providerKeys: string[]) { return this.service.reorderProviders({ provider_keys: providerKeys }); }
  async updateProvider(providerKey: string, payload: ProviderPayload) { return this.service.updateProvider(providerKey, payload); }
  async deleteProvider(providerKey: string) { this.service.deleteProvider(providerKey); }
  async checkProviderAvailability(providerKey: string) { return this.service.checkProviderAvailability(providerKey); }
  async getProviderMetrics(providerKey: string) { return this.service.getProviderMetrics(providerKey); }
  async testProvider(payload: TestProviderRequest) { return this.service.testProvider(payload); }
}
