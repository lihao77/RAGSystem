import type { FastifyRequest } from "fastify";

import type { RequestIdentity } from "@ragsystem/backend-core/identity/types.js";
import type { IdentityProvider } from "@ragsystem/backend-core/services/identity/identity-provider.js";
import { widgetUserId } from "./widget-user-id.js";
import type { WidgetAuthService } from "../services/widget-auth-service.js";

export class WidgetIdentityProvider implements IdentityProvider {
  constructor(
    private readonly auth: WidgetAuthService,
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
      originPrincipal: { type: "widget", id: claims.sub },
    };
  }

  private async resolveFromAppKey(request: FastifyRequest): Promise<{ sub: string; tenant_id: RequestIdentity["tenantId"] }> {
    const appKey = request.headers["x-widget-key"];
    if (typeof appKey !== "string" || !appKey) throw new Error("missing widget credentials");
    const app = await this.auth.verifyPublishableSession({ appKey, origin: request.headers.origin });
    return { sub: appKey, tenant_id: app.tenant_id };
  }
}
