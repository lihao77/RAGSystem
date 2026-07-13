import type { FastifyPluginAsync } from "fastify";

import {
  PatternRequestSchema,
  PermissionPolicySchema,
  SetModeRequestSchema,
} from "../contracts/permissions.js";
import type { RouteOptions } from "./route-options.js";

export const registerPermissionRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/policy", async (request) => request.container.permissionPolicy.getPolicy());

  app.put("/policy", async (request) => {
    const policy = PermissionPolicySchema.parse(request.body);
    return request.container.permissionPolicy.setPolicy(policy);
  });

  app.put("/mode", async (request) => {
    const payload = SetModeRequestSchema.parse(request.body);
    return request.container.permissionPolicy.setMode(payload.mode);
  });

  app.post("/auto-accept", async (request) => {
    const payload = PatternRequestSchema.parse(request.body);
    return request.container.permissionPolicy.addAutoAcceptPattern(payload);
  });

  app.delete("/auto-accept", async (request) => {
    const payload = PatternRequestSchema.parse(request.body);
    return request.container.permissionPolicy.removeAutoAcceptPattern(payload);
  });

  app.delete("/auto-accept/all", async (request) => request.container.permissionPolicy.clearAutoAcceptPatterns());
};
