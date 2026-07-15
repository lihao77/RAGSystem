import type { RequestIdentity, TenantId, UserId } from "./identity/types.js";
import type { RuntimeContainer } from "./services/runtime/runtime-container.js";
import type { TenantRuntimeLease } from "./services/runtime/tenant-runtime-registry.js";
import type { DaemonService } from "./services/daemon/daemon-service.js";
import type { ControlStore } from "./services/stores/control-store/index.js";

declare module "fastify" {
  interface FastifyInstance {
    botEngine: DaemonService;
    controlStore: ControlStore;
  }

  interface FastifyRequest {
    identity: RequestIdentity;
    userId: UserId;
    tenantId: TenantId;
    container: RuntimeContainer;
    tenantRuntimeLease: TenantRuntimeLease | null;
  }
}

export {};
