import type { ProviderApplication } from "../../../../contracts/application/provider-application.js";
import type { ProviderPayload, TestProviderRequest } from "../../../../contracts/integrations/model-adapter.js";
import type { ModelAdapterService } from "../../../../services/integrations/model-adapter-service.js";

export class LocalProviderApplication implements ProviderApplication {
  constructor(private readonly service: ModelAdapterService) {}

  listProviderTypes() { return this.service.listProviderTypes(); }
  listProviders() { return this.service.listProviders(); }
  createProvider(payload: ProviderPayload) { return this.service.createProvider(payload); }
  reorderProviders(providerKeys: string[]) { return this.service.reorderProviders({ provider_keys: providerKeys }); }
  updateProvider(providerKey: string, payload: ProviderPayload) { return this.service.updateProvider(providerKey, payload); }
  deleteProvider(providerKey: string) { this.service.deleteProvider(providerKey); }
  checkProviderAvailability(providerKey: string) { return this.service.checkProviderAvailability(providerKey); }
  getProviderMetrics(providerKey: string) { return this.service.getProviderMetrics(providerKey); }
  testProvider(payload: TestProviderRequest) { return this.service.testProvider(payload); }
}
