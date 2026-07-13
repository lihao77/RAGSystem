import type { FastifyRequest } from "fastify";

import type { RequestIdentity } from "../../identity/types.js";
import type { IdentityProvider } from "./identity-provider.js";

export abstract class PasswordIdentityProvider implements IdentityProvider {
  resolve(_request: FastifyRequest): RequestIdentity {
    throw new Error("password 身份认证尚未实现");
  }
}
