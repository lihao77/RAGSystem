import type { RouteOptions } from "../routes/route-options.js";
import type { SaaSRuntime } from "../services/runtime/saas-runtime-provider.js";
import type { RuntimeProvider } from "../services/runtime/tenant-runtime-registry.js";

/** Bridges Fastify identity context to the tenant-bound SaaS memory facade. */
export function createSaaSMemoryApplicationResolver(
  provider: RuntimeProvider<SaaSRuntime>,
): NonNullable<RouteOptions["resolveMemoryApplication"]> {
  return async (request) => {
    const lease = await provider.acquire(request.identity.tenantId);
    try {
      return lease.runtime.memory;
    } finally {
      lease.release();
    }
  };
}
