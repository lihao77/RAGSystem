import type { FastifyRequest } from "fastify";

import type { SessionApplication } from "../contracts/session-application.js";
import type { RouteOptions } from "./route-options.js";
import { ensureRequestApplications } from "../app/request-applications.js";

export async function resolveSessionApplication(
  options: RouteOptions,
  request: FastifyRequest,
): Promise<SessionApplication> {
  return (await ensureRequestApplications(request, options)).sessions;
}
