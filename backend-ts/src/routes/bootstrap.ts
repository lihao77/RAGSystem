import type { FastifyPluginAsync } from "fastify";

import { resolveDeploymentProfile, type AppEnv } from "../config/env.js";

interface BootstrapOptions {
  env: AppEnv;
}

export const registerBootstrapRoutes: FastifyPluginAsync<BootstrapOptions> = async (app, options) => {
  app.get("/bootstrap", async () => {
    const profile = resolveDeploymentProfile(options.env);
    const isLocal = profile.deployment === "local";
    return {
      deployment: profile.deployment,
      auth: profile.auth,
      tenancy: profile.tenancy,
      execution: profile.execution,
      storage: profile.storage,
      ui: profile.ui,
      capabilities: {
        login: !isLocal && profile.auth !== "local",
        tenantSwitch: !isLocal && profile.tenancy === "multi",
        members: !isLocal && profile.tenancy === "multi",
        billing: !isLocal && profile.deployment === "saas",
        widget: Boolean(options.env.widgetJwtSecret),
        localExecution: profile.execution === "local",
      },
    };
  });
};
