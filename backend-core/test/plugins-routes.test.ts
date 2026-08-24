import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import {
  registerPublicPluginUiManifestRoutes,
  registerTenantPluginRoutes,
} from "../src/routes/plugins.js";
import type { BackendUiContribution } from "../src/plugins/backend-plugin.js";
import { createTenantId, createUserId } from "../src/identity/types.js";

const uiContributions: readonly BackendUiContribution[] = [
  {
    pluginId: "pet",
    manifest: {
      bundleUrl: "/api/pet/ui/bundle.js",
      exposePublic: true,
      views: [{ route: "/pet", entry: "PetPanel", placement: "standalone", public: true }],
    },
  },
  {
    pluginId: "internal",
    manifest: {
      bundleUrl: "/api/internal/ui/bundle.js",
      views: [{ route: "/internal", entry: "Panel", placement: "management" }],
    },
  },
];

const listing = {
  listPlugins: () => [
    { id: "pet", version: "0.1.0" },
    { id: "internal", version: "0.2.0" },
    { id: "no-ui", version: "1.0.0" },
  ],
  listUi: () => uiContributions,
};

describe("plugin registry routes", () => {
  it("public ui-manifests endpoint lists only exposePublic plugins", async () => {
    const app = Fastify();
    await app.register(registerPublicPluginUiManifestRoutes, { prefix: "/api", ...listing });

    const response = await app.inject({ method: "GET", url: "/api/plugins/ui-manifests" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.plugins).toEqual([
      {
        id: "pet",
        bundleUrl: "/api/pet/ui/bundle.js",
        views: [{ route: "/pet", entry: "PetPanel", placement: "standalone", public: true }],
      },
    ]);
    expect(body.data.plugins.some((plugin: { id: string }) => plugin.id === "internal")).toBe(false);
    await app.close();
  });

  it("tenant endpoint maps config groups to plugins by sourceExtension", async () => {
    const app = Fastify();
    app.decorateRequest("container", null as never);
    app.decorateRequest("identity", null as never);
    app.addHook("onRequest", async (request) => {
      request.identity = { userId: createUserId("usr_u1"), tenantId: createTenantId("tnt_t1"), role: "owner", permissions: [] };
      request.container = {
        systemConfig: {
          getSchema: () => ({
            groups: [
              { key: "llm", label: "LLM", description: "", fields: [] },
              { key: "pet", label: "宠物", description: "", fields: [], sourceExtension: "pet" },
              { key: "orphan", label: "孤儿", description: "", fields: [], sourceExtension: "gone" },
            ],
          }),
        },
      } as never;
    });
    await app.register(async (scope) => {
      scope.addHook("preHandler", async () => {});
      await scope.register(registerTenantPluginRoutes, { prefix: "/api/plugins", ...listing });
    });

    const response = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(response.statusCode).toBe(200);
    const plugins = response.json().data.plugins;
    expect(plugins).toHaveLength(3);
    expect(plugins.find((plugin: { id: string }) => plugin.id === "pet")).toEqual({
      id: "pet",
      version: "0.1.0",
      ui: {
        bundleUrl: "/api/pet/ui/bundle.js",
        views: [{ route: "/pet", entry: "PetPanel", placement: "standalone", public: true }],
      },
      configGroups: ["pet"],
    });
    expect(plugins.find((plugin: { id: string }) => plugin.id === "no-ui")).toEqual({
      id: "no-ui",
      version: "1.0.0",
      ui: null,
      configGroups: [],
    });
    await app.close();
  });
});
