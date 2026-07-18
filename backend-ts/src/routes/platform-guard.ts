import type { FastifyRequest } from "fastify";

import type { ControlPlane } from "../contracts/control-plane/index.js";
import { HttpError } from "../utils/errors.js";

export async function requirePlatformAdmin(request: FastifyRequest, controlPlane: ControlPlane) {
  const user = await controlPlane.users.get(request.identity.userId);
  if (!user || user.status !== "active" || user.platformRole !== "admin") {
    throw new HttpError(403, "forbidden", "需要 active 平台管理员权限");
  }
  return user;
}
