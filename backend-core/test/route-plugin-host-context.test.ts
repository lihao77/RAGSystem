import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerPublicAndAuthRoutes } from "../src/app/route-assembly.js";
import type { AppEnv } from "../src/config/env.js";
import type { ControlPlane } from "../src/contracts/control-plane/index.js";
import type { DeploymentProfile } from "../src/identity/types.js";
import {
  BACKEND_HOST_RESOURCES,
  requireBackendPluginResource,
} from "../src/plugins/host-resources.js";
import {
  createBackendResourceToken,
  provideBackendResource,
} from "../src/plugins/resource-registry.js";
import type {
  BackendRouteContribution,
  BackendRouteHostContext,
} from "../src/plugins/backend-plugin.js";
import type { RuntimeContainerRegistry } from "../src/services/runtime/runtime-container-registry.js";

const profile: DeploymentProfile = {
  deployment: "local",
  auth: "local",
  tenancy: "single",
  execution: "local",
  storage: "sqlite",
  ui: "local",
};

function stubControlPlane(): ControlPlane {
  return {
    settings: {
      get: async () => undefined,
      getAll: async () => ({}),
      set: async () => undefined,
      setMany: async () => undefined,
    },
    health: {
      checkReadiness: async () => ({ ready: true, currentSchemaVersion: 1, latestSchemaVersion: 1 }),
    },
  } as unknown as ControlPlane;
}

function hostConsumerRoute(captured: { host?: BackendRouteHostContext | undefined }): BackendRouteContribution {
  return {
    pluginId: "test-host-consumer",
    scope: "public",
    prefix: "/api/test-host",
    install: async (app, context) => {
      captured.host = context.host;
      app.get("/", async () => ({ ok: true }));
    },
  };
}

describe("plugin route install context host", () => {
  it("delivers registry and merged resources to public-scope plugin routes at install time", async () => {
    const captured: { host?: BackendRouteHostContext | undefined } = {};
    const registry = { closeTenant: async () => undefined } as unknown as RuntimeContainerRegistry;
    const markerToken = createBackendResourceToken<string>("test.host.marker", "test-owner");
    const host: BackendRouteHostContext = {
      registry,
      resources: [
        provideBackendResource(markerToken, "marker-value", "test-owner"),
        provideBackendResource(BACKEND_HOST_RESOURCES.deployment, { kind: "local" }, "test-owner"),
      ],
    };

    const app = Fastify();
    await registerPublicAndAuthRoutes(app, {
      env: {} as AppEnv,
      controlPlane: stubControlPlane(),
      runtime: {
        profile,
        identityProvider: {
          resolve: async () => {
            throw new Error("public-scope plugin routes must not resolve identity");
          },
        },
      },
      pluginRoutes: [hostConsumerRoute(captured)],
      pluginRouteHost: host,
    });
    await app.ready();

    expect(captured.host).toBeDefined();
    expect(captured.host?.registry).toBe(registry);
    expect(requireBackendPluginResource<{ kind: string }>(captured.host?.resources, BACKEND_HOST_RESOURCES.deployment).kind)
      .toBe("local");
    expect(requireBackendPluginResource<string>(captured.host?.resources, markerToken)).toBe("marker-value");

    const response = await app.inject({ method: "GET", url: "/api/test-host/" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  it("omits host when the assembler does not provide one (backwards compatible)", async () => {
    const captured: { host?: BackendRouteHostContext | undefined } = {};

    const app = Fastify();
    await registerPublicAndAuthRoutes(app, {
      env: {} as AppEnv,
      controlPlane: stubControlPlane(),
      runtime: {
        profile,
        identityProvider: { resolve: async () => {
          throw new Error("not expected");
        } },
      },
      pluginRoutes: [hostConsumerRoute(captured)],
    });
    await app.ready();

    expect(captured.host).toBeUndefined();
    const response = await app.inject({ method: "GET", url: "/api/test-host/" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
