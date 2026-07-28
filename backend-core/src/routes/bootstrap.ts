import type { FastifyPluginAsync } from "fastify";

import type { AppEnv } from "../config/env.js";
import type { ControlPlane } from "../contracts/control-plane/index.js";
import type { DeploymentProfile } from "../identity/types.js";

interface BootstrapOptions {
  env: AppEnv;
  controlPlane: ControlPlane;
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
      installed: await options.controlPlane.settings.get("installed") === "true",
      ...(isLocal ? { platformRole: "admin" as const } : {}),
      capabilities: {
        login: !isLocal && profile.auth !== "local",
        tenantSwitch: !isLocal && profile.tenancy === "multi",
        members: !isLocal && profile.tenancy === "multi",
        billing: !isLocal && profile.deployment === "saas",
        localExecution: profile.execution === "local",
      },
    };
  });
};
