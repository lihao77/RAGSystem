import type { RequestIdentity, TenantId, UserId } from "./identity/types.js";
import type { RuntimeContainer } from "./services/runtime/runtime-container.js";
import type { TenantRuntimeLease } from "./services/runtime/tenant-runtime-registry.js";
import type { DaemonService } from "./services/daemon/daemon-service.js";
import type { BotRepository } from "./contracts/bot-repository.js";

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
  }
}

export {};
