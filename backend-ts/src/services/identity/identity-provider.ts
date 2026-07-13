import type { FastifyRequest } from "fastify";

import type { RequestIdentity } from "../../identity/types.js";

export interface IdentityProvider {
  resolve(request: FastifyRequest): RequestIdentity;
}
