import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type { ProviderConfigRecord } from "@ragsystem/backend-core/contracts/integrations/provider-repository.js";

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
