import type { FastifyRequest } from "fastify";

import type { RequestIdentity } from "../../identity/types.js";
import type { ControlPlane } from "../../contracts/control-plane/index.js";
import type { SessionTokenService } from "../runtime/session-token-service.js";
import { AuthError } from "./auth-error.js";
import type { IdentityProvider } from "./identity-provider.js";

export class PasswordIdentityProvider implements IdentityProvider {
  constructor(
    private readonly controlPlane: ControlPlane,
    private readonly sessionTokens: SessionTokenService,
  ) {}

  async resolve(request: FastifyRequest, scope: "tenant" | "platform" = "tenant"): Promise<RequestIdentity> {
    const claims = await this.sessionTokens.requireBearer(request);
    const user = await this.controlPlane.users.get(claims.sub);
    if (!user || user.status === "disabled") throw new AuthError("用户已被禁用");
    if (scope === "platform") {
      return {
        userId: user.id,
        tenantId: claims.tenant_id,
        role: claims.role,
        permissions: [],
        ...(user.platformRole ? { platformRole: user.platformRole } : {}),
      };
    }
    const tenant = await this.controlPlane.tenants.get(claims.tenant_id);
    if (!tenant || tenant.status === "suspended") throw new AuthError("租户已暂停");
    const membership = await this.controlPlane.memberships.get(claims.sub, claims.tenant_id);
    if (!membership || membership.role !== claims.role) throw new AuthError("session identity 无效");
    return {
      userId: user.id,
      tenantId: membership.tenantId,
      role: membership.role,
      permissions: membership.role === "owner" || membership.role === "admin" ? ["*"] : [],
      ...(user.platformRole ? { platformRole: user.platformRole } : {}),
    };
  }
}
