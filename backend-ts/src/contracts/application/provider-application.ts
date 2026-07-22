import type {
  ProviderPayload,
  ProviderTypeInfo,
  TestProviderRequest,
  ModelProviderConfig,
} from "../integrations/model-adapter.js";

export interface ProviderAvailability {
  provider_key: string;
  is_available: boolean;
  checks: Record<string, boolean>;
  error: string | null;
}

export interface ProviderMetrics {
  provider_key: string;
  resilience: unknown;
}

/** Tenant-bound provider administration and runtime checks. */
export interface ProviderApplication {
  listProviderTypes(): Promise<ProviderTypeInfo[]>;
  listProviders(): Promise<ModelProviderConfig[]>;
  createProvider(payload: ProviderPayload): Promise<string>;
  reorderProviders(providerKeys: string[]): Promise<string[]>;
  updateProvider(providerKey: string, payload: ProviderPayload): Promise<string>;
  deleteProvider(providerKey: string): Promise<void>;
  checkProviderAvailability(providerKey: string): Promise<ProviderAvailability>;
  getProviderMetrics(providerKey: string): Promise<ProviderMetrics>;
  testProvider(payload: TestProviderRequest): Promise<Record<string, unknown>>;
}
