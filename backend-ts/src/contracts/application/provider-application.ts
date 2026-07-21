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
  listProviderTypes(): ProviderTypeInfo[] | Promise<ProviderTypeInfo[]>;
  listProviders(): ModelProviderConfig[] | Promise<ModelProviderConfig[]>;
  createProvider(payload: ProviderPayload): string | Promise<string>;
  reorderProviders(providerKeys: string[]): string[] | Promise<string[]>;
  updateProvider(providerKey: string, payload: ProviderPayload): string | Promise<string>;
  deleteProvider(providerKey: string): void | Promise<void>;
  checkProviderAvailability(providerKey: string): ProviderAvailability | Promise<ProviderAvailability>;
  getProviderMetrics(providerKey: string): ProviderMetrics | Promise<ProviderMetrics>;
  testProvider(payload: TestProviderRequest): Record<string, unknown> | Promise<Record<string, unknown>>;
}
