import type { FastifyRequest } from "fastify";

import type { RequestIdentity } from "../../identity/types.js";
import type { IdentityProvider } from "./identity-provider.js";

export abstract class OidcIdentityProvider implements IdentityProvider {
  async resolve(_request: FastifyRequest): Promise<RequestIdentity> {
    throw new Error("oidc 身份认证尚未实现");
  }
}
