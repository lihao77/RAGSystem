import type { RequestIdentity, TenantId, UserId } from "./identity/types.js";
import type { RuntimeContainer } from "./services/runtime/runtime-container.js";
import type { TenantRuntimeLease } from "./services/runtime/tenant-runtime-registry.js";

declare module "fastify" {
  interface FastifyRequest {
    identity: RequestIdentity;
    userId: UserId;
    tenantId: TenantId;
    container: RuntimeContainer;
    tenantRuntimeLease: TenantRuntimeLease | null;
  }
}

export {};
