export interface ProviderUsage {
  kind: string;
  key: string;
  label: string;
  detail: string;
}

export const PROVIDER_USAGE_CONTRIBUTOR = Symbol.for("@ragsystem/backend/provider-usage-contributor");

export interface ProviderUsageContributor {
  [PROVIDER_USAGE_CONTRIBUTOR](providerAliases: ReadonlySet<string>): Promise<readonly ProviderUsage[]>;
}

export function isProviderUsageContributor(value: unknown): value is ProviderUsageContributor {
  return typeof value === "object"
    && value !== null
    && PROVIDER_USAGE_CONTRIBUTOR in value
    && typeof (value as ProviderUsageContributor)[PROVIDER_USAGE_CONTRIBUTOR] === "function";
}
