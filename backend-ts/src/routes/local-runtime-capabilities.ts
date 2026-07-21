import type { FastifyRequest } from "fastify";
import type { LocalRuntimeCapabilities } from "../contracts/runtime/runtime-container.js";
import { HttpError } from "../utils/errors.js";

export function requireLocalRuntime(request: FastifyRequest, operation: string): LocalRuntimeCapabilities {
  if (!request.container.local) throw new HttpError(501, "not_implemented", `${operation} is not available in SaaS`);
  return request.container.local;
}
