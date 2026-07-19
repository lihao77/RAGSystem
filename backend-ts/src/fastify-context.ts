import type { RequestIdentity, TenantId, UserId } from "./identity/types.js";
import type { RuntimeContainer } from "./contracts/runtime/runtime-container.js";
import type { TenantRuntimeLease } from "./adapters/local/tenant-runtime-registry.js";
import type { DaemonService } from "./services/daemon/daemon-service.js";
import type { BotRepository } from "./contracts/control-plane/bot-repository.js";
import type { RequestApplications } from "./app/request-applications.js";
import type { RequestResources } from "./app/request-resources.js";

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: "public";
  }

  interface FastifyInstance {
    botEngine: DaemonService;
    botRepository: BotRepository;
  }

  interface FastifyRequest {
    identity: RequestIdentity;
    userId: UserId;
    tenantId: TenantId;
    container: RuntimeContainer;
    tenantRuntimeLease: TenantRuntimeLease | null;
    applications?: RequestApplications;
    resources?: RequestResources;
  }
}

export {};
