import type { FastifyPluginAsync } from "fastify";

import {
  PatternRequestSchema,
  PermissionPolicySchema,
  SetModeRequestSchema,
} from "../contracts/permissions.js";
import type { RouteOptions } from "./route-options.js";

export const registerPermissionRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/policy", async () => options.container.permissionPolicy.getPolicy());

  app.put("/policy", async (request) => {
    const policy = PermissionPolicySchema.parse(request.body);
    return options.container.permissionPolicy.setPolicy(policy);
  });

  app.put("/mode", async (request) => {
    const payload = SetModeRequestSchema.parse(request.body);
    return options.container.permissionPolicy.setMode(payload.mode);
  });

  app.post("/auto-accept", async (request) => {
    const payload = PatternRequestSchema.parse(request.body);
    return options.container.permissionPolicy.addAutoAcceptPattern(payload);
  });

  app.delete("/auto-accept", async (request) => {
    const payload = PatternRequestSchema.parse(request.body);
    return options.container.permissionPolicy.removeAutoAcceptPattern(payload);
  });

  app.delete("/auto-accept/all", async () => options.container.permissionPolicy.clearAutoAcceptPatterns());
};
