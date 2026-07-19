import type { FastifyRequest } from "fastify";

import type { WidgetCredentialRepository } from "../../contracts/control-plane/widget-credentials.js";
import type { RequestIdentity } from "../../identity/types.js";
import { widgetUserId } from "../../identity/widget-user-id.js";
import type { WidgetAuthService } from "../runtime/jwt-service.js";
import type { IdentityProvider } from "./identity-provider.js";

export class WidgetIdentityProvider implements IdentityProvider {
  constructor(
    private readonly auth: WidgetAuthService,
    private readonly credentials: WidgetCredentialRepository,
  ) {}

  async resolve(request: FastifyRequest): Promise<RequestIdentity> {
    const claims = request.headers.authorization
      ? await this.auth.requireBearer(request)
      : await this.resolveFromAppKey(request);
    return {
      userId: widgetUserId(claims.sub),
      tenantId: claims.tenant_id,
      role: "widget",
      permissions: ["sessions:create"],
    };
  }

  private async resolveFromAppKey(request: FastifyRequest): Promise<{ sub: string; tenant_id: RequestIdentity["tenantId"] }> {
    const appKey = request.headers["x-widget-key"];
    if (typeof appKey !== "string" || !appKey) throw new Error("missing widget credentials");
    const tenantId = await this.credentials.apps.resolveTenantId(appKey);
    if (!tenantId) throw new Error("widget app 不存在");
    return { sub: appKey, tenant_id: tenantId };
  }
}
