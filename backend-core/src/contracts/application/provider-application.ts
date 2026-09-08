import type {
  CatalogModelsResult,
  CatalogProvidersResult,
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

/** 加载面拒载的 provider 记录（配置损坏：模型条目思考形状缺失/失配等）。 */
export interface ProviderLoadError {
  key: string;
  message: string;
}

/** Tenant-bound provider administration and runtime checks. */
export interface ProviderApplication {
  listApiFormats(): Promise<ProviderTypeInfo[]>;
  listProviders(): Promise<ModelProviderConfig[]>;
  /** 损坏配置的报错通道（加载面拒载记录，随列表界面暴露）。 */
  listProviderLoadErrors(): Promise<ProviderLoadError[]>;
  createProvider(payload: ProviderPayload): Promise<string>;
  reorderProviders(providerKeys: string[]): Promise<string[]>;
  updateProvider(providerKey: string, payload: ProviderPayload): Promise<string>;
  deleteProvider(providerKey: string): Promise<void>;
  checkProviderAvailability(providerKey: string): Promise<ProviderAvailability>;
  getProviderMetrics(providerKey: string): Promise<ProviderMetrics>;
  testProvider(payload: TestProviderRequest): Promise<Record<string, unknown>>;
  /** Models.dev 目录（进程级只读元数据，供配置界面建议/自动填充；不参与校验）。 */
  listCatalogProviders(): Promise<CatalogProvidersResult>;
  listCatalogModels(catalogProviderId: string): Promise<CatalogModelsResult>;
}
