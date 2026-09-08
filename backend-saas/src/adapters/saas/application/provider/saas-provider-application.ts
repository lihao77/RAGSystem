import type { ProviderApplication } from "@ragsystem/backend-core/contracts/application/provider-application.js";
import type {
  ProviderConfigRecord,
  ProviderRepository,
} from "@ragsystem/backend-core/contracts/integrations/provider-repository.js";
import type {
  ModelProviderConfig,
  ProviderPayload,
  TestProviderRequest,
} from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import {
  ModelAdapterService,
  ModelAdapterServiceError,
} from "@ragsystem/backend-core/services/integrations/model-adapter-service.js";
import { toHydratedModelProviderConfig, toModelProviderConfig } from "./provider-config-mapping.js";

/**
 * Tenant-bound provider application.
 * PostgreSQL is the sole source of truth; ModelAdapterService is only the in-process projection + validation.
 */
export class SaaSProviderApplication implements ProviderApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly service: ModelAdapterService,
    private readonly repository: ProviderRepository,
  ) {}

  async listApiFormats() {
    return this.service.listApiFormats();
  }

  async listProviders(): Promise<ModelProviderConfig[]> {
    // 走运行时快照（replaceRuntimeProviders 归一链含 thinking_kind 下沉迁移）而非仓库原始行：
    // 存量行模型条目无 thinking_kind，原始直读会让 /providers 的逐条目 thinking descriptor
    // 注入抛错（500）；快照口径与 load_errors 同源，也消除同请求内两种归一状态的不一致。
    await this.hydrateRuntimeFromRepository();
    return this.service.listProviders();
  }

  async listProviderLoadErrors() {
    // 拒载记录基于运行时快照；与 listProviders 同刻读取前先对齐运行时，保证错误与列表一致。
    await this.hydrateRuntimeFromRepository();
    return this.service.listProviderLoadErrors();
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
    // existing 过加载归一链（含 thinking_kind 下沉迁移）再进 update 校验：存量行条目无
    // thinking_kind，直读会让终局校验恒 400"缺少声明"——单字段保存（如改 endpoint）死路。
    const existing = toHydratedModelProviderConfig(existingRecord);
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

  async checkProviderAvailability(providerKey: string) {
    return this.service.checkProviderAvailability(providerKey);
  }

  async getProviderMetrics(providerKey: string) {
    return this.service.getProviderMetrics(providerKey);
  }

  async testProvider(payload: TestProviderRequest) {
    return this.service.testProvider(payload);
  }

  async listCatalogProviders() {
    return this.service.listCatalogProviders();
  }

  async listCatalogModels(catalogProviderId: string) {
    return this.service.listCatalogModels(catalogProviderId);
  }

  private async hydrateRuntimeFromRepository(): Promise<void> {
    const records = await this.repository.listProviders(this.tenantId);
    this.service.replaceRuntimeProviders(records.map(toModelProviderConfig));
  }
}

// Re-export record types used by tests that import this module's helpers historically.
export type { ProviderConfigRecord };
