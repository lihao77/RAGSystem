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
    if (!user || user.status === "disabled") throw new AuthError("用户已被禁用");
    if (isPlatformRequest(request.url)) {
      return {
        userId: user.id,
        tenantId: claims.tenant_id,
        role: claims.role,
        permissions: [],
        ...(user.platformRole ? { platformRole: user.platformRole } : {}),
      };
    }
    const tenant = this.controlStore.getTenant(claims.tenant_id);
    if (!tenant || tenant.status === "suspended") throw new AuthError("租户已暂停");
    const membership = this.controlStore.getMembership(claims.sub, claims.tenant_id);
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

function isPlatformRequest(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/api/platform" || pathname.startsWith("/api/platform/");
}
