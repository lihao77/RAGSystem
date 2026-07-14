import type { FastifyPluginAsync } from "fastify";

import type { AppEnv } from "../config/env.js";
import type { DeploymentProfile } from "../identity/types.js";
import type { ControlStore } from "../services/stores/control-store/index.js";

interface BootstrapOptions {
  env: AppEnv;
  controlStore: ControlStore;
  runtime: { profile: DeploymentProfile };
}

export const registerBootstrapRoutes: FastifyPluginAsync<BootstrapOptions> = async (app, options) => {
  app.get("/bootstrap", async () => {
    const profile = options.runtime.profile;
    const isLocal = profile.deployment === "local";
    return {
      deployment: profile.deployment,
      auth: profile.auth,
      tenancy: profile.tenancy,
      execution: profile.execution,
      storage: profile.storage,
      ui: profile.ui,
      installed: options.controlStore.getSetting("installed") === "true",
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
