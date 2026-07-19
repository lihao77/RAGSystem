import type { RouteOptions } from "../routes/route-options.js";
import type { SaaSMemoryApplicationProvider } from "../adapters/saas/composition/saas-runtime-provider.js";

/** Bridges Fastify identity context to the tenant-bound SaaS memory facade. */
export function createSaaSMemoryApplicationResolver(
  provider: SaaSMemoryApplicationProvider,
): NonNullable<RouteOptions["resolveMemoryApplication"]> {
  return (request) => provider.memoryForTenant(request.identity.tenantId);
}
