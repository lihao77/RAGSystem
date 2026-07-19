import type { FastifyRequest } from "fastify";

import { LocalSessionApplication } from "../adapters/local/local-session-application.js";
import type { SessionApplication } from "../contracts/session-application.js";
import type { RouteOptions } from "./route-options.js";

export async function resolveSessionApplication(
  options: RouteOptions,
  request: FastifyRequest,
): Promise<SessionApplication> {
  return await options.resolveSessionApplication?.(request)
    ?? new LocalSessionApplication(
      request.identity.tenantId,
      request.container.sessionApplication,
      request.container.conversationStore,
    );
}
