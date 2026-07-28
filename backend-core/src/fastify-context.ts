import type { RequestIdentity, TenantId, UserId } from "./identity/types.js";
import type { RuntimeContainer } from "./contracts/runtime/runtime-container.js";
import type { RuntimeContainerLease as TenantRuntimeLease } from "./services/runtime/runtime-container-registry.js";
import type { BotRepository } from "./contracts/control-plane/bot-repository.js";
import type { RequestApplications } from "./app/request-applications.js";
import type { RequestResources } from "./app/request-resources.js";

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: "public";
  }

  interface FastifyInstance {
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
