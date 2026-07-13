import type { FastifyRequest } from "fastify";

import { createUserId, type RequestIdentity } from "../../identity/types.js";
import type { WidgetAuthService } from "../runtime/jwt-service.js";
import type { WidgetCredentialStore } from "../stores/widget-credential-store/index.js";
import type { IdentityProvider } from "./identity-provider.js";

export class WidgetIdentityProvider implements IdentityProvider {
  constructor(
    private readonly auth: WidgetAuthService,
    private readonly store: WidgetCredentialStore,
  ) {}

  resolve(request: FastifyRequest): RequestIdentity {
    const claims = request.headers.authorization
      ? this.auth.requireBearer(request)
      : this.resolveFromAppKey(request);
    return {
      userId: createUserId(`usr_widget_${normalizeAppKey(claims.sub)}`),
      tenantId: claims.tenant_id,
      role: "widget",
      permissions: ["sessions:create"],
    };
  }

  private resolveFromAppKey(request: FastifyRequest): { sub: string; tenant_id: RequestIdentity["tenantId"] } {
    const appKey = request.headers["x-widget-key"];
    if (typeof appKey !== "string" || !appKey) throw new Error("missing widget credentials");
    const tenantId = this.store.ops.resolveTenantId(appKey);
    if (!tenantId) throw new Error("widget app 不存在");
    return { sub: appKey, tenant_id: tenantId };
  }
}

function normalizeAppKey(appKey: string): string {
  return appKey.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
