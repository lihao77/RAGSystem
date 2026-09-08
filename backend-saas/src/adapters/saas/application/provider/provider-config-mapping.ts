import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type { ProviderConfigRecord } from "@ragsystem/backend-core/contracts/integrations/provider-repository.js";
import { runProviderFormNormalization } from "@ragsystem/backend-core/services/integrations/model-adapter-hydration.js";

/** Map a PostgreSQL provider row into the runtime ModelProviderConfig shape. */
export function toModelProviderConfig(record: ProviderConfigRecord): ModelProviderConfig {
  const config = { ...record.config } as Record<string, unknown>;
  return {
    ...config,
    name: String(config.name ?? record.provider_key),
    provider_type: String(config.provider_type ?? ""),
    key: record.provider_key,
    // models 原样透传；废弃字段剥离与条目归一由 replaceRuntimeProviders 统一处理。
    models: Array.isArray(config.models) ? config.models : [],
    is_loaded: true,
  };
}

/**
 * 仓库行 → 加载口径配置：映射后再过形态归一链（与 loadProvidersFromDisk /
 * replaceRuntimeProviders 同一组步骤，含 thinking_kind 下沉迁移）。供 update 等
 * 需要以"存量迁移后形态"为基底的路径使用——原始行条目无 thinking_kind，直用会被
 * 终局校验 400 拒绝。
 */
export function toHydratedModelProviderConfig(record: ProviderConfigRecord): ModelProviderConfig {
  const config = toModelProviderConfig(record);
  runProviderFormNormalization(config);
  return config;
}
