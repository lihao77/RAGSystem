import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type { ProviderConfigRecord } from "@ragsystem/backend-core/contracts/integrations/provider-repository.js";

/** Map a PostgreSQL provider row into the runtime ModelProviderConfig shape. */
export function toModelProviderConfig(record: ProviderConfigRecord): ModelProviderConfig {
  const config = { ...record.config } as Record<string, unknown>;
  const modelMap = isRecord(config.model_map) ? config.model_map : {};
  const models = Array.isArray(config.models)
    ? config.models.filter((item): item is string => typeof item === "string")
    : Object.values(modelMap).flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((item): item is string => typeof item === "string");
  return {
    ...config,
    name: String(config.name ?? record.provider_key),
    provider_type: String(config.provider_type ?? ""),
    key: record.provider_key,
    models,
    model_map: modelMap as ModelProviderConfig["model_map"],
    is_loaded: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
