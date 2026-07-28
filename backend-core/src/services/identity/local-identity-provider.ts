import type { FastifyRequest } from "fastify";

import {
  createTenantId,
  createUserId,
  type RequestIdentity,
} from "../../identity/types.js";
import type { ControlPlane } from "../../contracts/control-plane/index.js";
import type { IdentityProvider } from "./identity-provider.js";

export const LOCAL_TENANT_ID = createTenantId("tnt_local");
export const LOCAL_USER_ID = createUserId("usr_local");

export class LocalIdentityProvider implements IdentityProvider {
  private initialization: Promise<void> | null = null;

  constructor(private readonly controlPlane: ControlPlane) {}

  async resolve(_request: FastifyRequest): Promise<RequestIdentity> {
    await this.initialize();
    return {
      userId: LOCAL_USER_ID,
      tenantId: LOCAL_TENANT_ID,
      role: "owner",
      permissions: ["*"],
      platformRole: "admin",
    };
  }

  async initialize(): Promise<void> {
    this.initialization ??= this.initializeDefaults();
    await this.initialization;
  }

  private async initializeDefaults(): Promise<void> {
    await this.controlPlane.provisioning.ensureLocalIdentity({
      tenant: { id: LOCAL_TENANT_ID, displayName: "Local" },
      user: { id: LOCAL_USER_ID, displayName: "Local User", platformRole: "admin" },
      role: "owner",
    });
  }
}
