import type { FastifyRequest } from "fastify";

import {
  createTenantId,
  createUserId,
  type RequestIdentity,
} from "../../identity/types.js";
import type { ControlStore } from "../stores/control-store/index.js";
import type { IdentityProvider } from "./identity-provider.js";

export const LOCAL_TENANT_ID = createTenantId("tnt_local");
export const LOCAL_USER_ID = createUserId("usr_local");

export class LocalIdentityProvider implements IdentityProvider {
  constructor(private readonly controlStore: ControlStore) {
    this.initializeDefaults();
  }

  resolve(_request: FastifyRequest): RequestIdentity {
    return {
      userId: LOCAL_USER_ID,
      tenantId: LOCAL_TENANT_ID,
      role: "owner",
      permissions: ["*"],
    };
  }

  private initializeDefaults(): void {
    if (!this.controlStore.getTenant(LOCAL_TENANT_ID)) {
      this.controlStore.createTenant({ id: LOCAL_TENANT_ID, displayName: "Local" });
    }
    if (!this.controlStore.getUser(LOCAL_USER_ID)) {
      this.controlStore.createUser({ id: LOCAL_USER_ID, displayName: "Local User" });
    }
    this.controlStore.upsertMembership({
      userId: LOCAL_USER_ID,
      tenantId: LOCAL_TENANT_ID,
      role: "owner",
    });
  }
}
