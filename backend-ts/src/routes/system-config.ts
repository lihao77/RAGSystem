import type { FastifyPluginAsync } from "fastify";

import { ok } from "../contracts/common.js";
import { SystemConfigUpdateSchema } from "../contracts/runtime/system-config.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { requireTenantMember, requireTenantOwner } from "./tenant-role.js";
import { isRecord } from "../utils/guards.js";

export const registerSystemConfigRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/schema", async (request) => ok(request.container.systemConfig.getSchema(), "系统配置 schema"));

  app.get("/", async (request) => ok(request.container.systemConfig.getConfig(), "当前系统配置"));

  app.patch("/", async (request) => {
    requireTenantOwner(request);
    if (!isRecord(request.body)) {
      throw new HttpError(400, "invalid_request", "请求体必须是 JSON object");
    }
    const payload = SystemConfigUpdateSchema.parse(request.body);
    return ok(await request.container.systemConfig.updateConfig(payload), "系统配置已更新");
  });

  app.post("/reload", async (request) => {
    requireTenantOwner(request);
    await request.container.systemConfig.reload();
    return ok(undefined, "系统配置已重新加载");
  });
};
