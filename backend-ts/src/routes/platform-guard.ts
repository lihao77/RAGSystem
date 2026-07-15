import type { FastifyRequest } from "fastify";

import type { ControlStore } from "../services/stores/control-store/index.js";
import { HttpError } from "../utils/errors.js";

export function requirePlatformAdmin(request: FastifyRequest, controlStore: ControlStore) {
  const user = controlStore.getUser(request.identity.userId);
  if (!user || user.status !== "active" || user.platformRole !== "admin") {
    throw new HttpError(403, "forbidden", "需要 active 平台管理员权限");
  }
  return user;
}
