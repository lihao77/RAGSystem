import type { FastifyRequest } from "fastify";

import type { RequestIdentity } from "../identity/types.js";
import { HttpError } from "../utils/errors.js";

export type TenantRole = "owner" | "admin" | "member";

const ROLE_LEVEL: Record<TenantRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

export function assertTenantRole(identity: RequestIdentity, minRole: TenantRole): RequestIdentity {
  const roleLevel = ROLE_LEVEL[identity.role as TenantRole];
  if (roleLevel === undefined || roleLevel < ROLE_LEVEL[minRole]) {
    throw new HttpError(403, "forbidden", "无权执行该租户操作");
  }
  return identity;
}

export function requireTenantRole(request: FastifyRequest, minRole: TenantRole): RequestIdentity {
  return assertTenantRole(request.identity, minRole);
}

export function requireTenantMember(request: FastifyRequest): RequestIdentity {
  return requireTenantRole(request, "member");
}

export function requireTenantAdmin(request: FastifyRequest): RequestIdentity {
  return requireTenantRole(request, "admin");
}

export function requireTenantOwner(request: FastifyRequest): RequestIdentity {
  return requireTenantRole(request, "owner");
}
