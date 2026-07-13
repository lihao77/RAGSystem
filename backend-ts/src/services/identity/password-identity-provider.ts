import type { FastifyRequest } from "fastify";

import type { RequestIdentity } from "../../identity/types.js";
import type { SessionTokenService } from "../runtime/session-token-service.js";
import type { ControlStore } from "../stores/control-store/index.js";
import { AuthError } from "./auth-error.js";
import type { IdentityProvider } from "./identity-provider.js";

export class PasswordIdentityProvider implements IdentityProvider {
  constructor(
    private readonly controlStore: ControlStore,
    private readonly sessionTokens: SessionTokenService,
  ) {}

  resolve(request: FastifyRequest): RequestIdentity {
    const claims = this.sessionTokens.requireBearer(request);
    const user = this.controlStore.getUser(claims.sub);
    const membership = this.controlStore.getMembership(claims.sub, claims.tenant_id);
    if (!user || !membership || membership.role !== claims.role) throw new AuthError("session identity 无效");
    return {
      userId: user.id,
      tenantId: membership.tenantId,
      role: membership.role,
      permissions: membership.role === "owner" || membership.role === "admin" ? ["*"] : [],
    };
  }
}
