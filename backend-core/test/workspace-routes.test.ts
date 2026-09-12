import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { registerSessionRoutes } from "../src/routes/agent/sessions.js";
import type { SessionApplication } from "../src/contracts/session/session-application.js";
import type { RequestApplications } from "../src/app/request-applications.js";
import type { AgentRouteOptions } from "../src/routes/route-options.js";
import { LOCAL_USER_ID } from "../src/services/identity/local-identity.js";
import { createTenantId } from "../src/identity/types.js";

const tenantId = createTenantId("tnt_test");

function createApplication(renames: Array<{ workspaceId: string; displayName: string }>) {
  const application = {
    renameWorkspace: async (workspaceId: string, displayName: string) => {
      if (workspaceId !== "workspace-alpha") return null;
      renames.push({ workspaceId, displayName });
      return {
        workspace_id: workspaceId,
        tenant_id: tenantId,
        kind: "local" as const,
        display_name: displayName,
        root_path: "D:/alpha",
        canonical_key: "d:/alpha",
        removed_at: null,
        created_at: "2026-07-26T00:00:00.000Z",
        updated_at: "2026-07-26T00:00:00.000Z",
      };
    },
  };
  return application as unknown as SessionApplication;
}

async function createApp(deploymentKind: "local" | "saas") {
  const renames: Array<{ workspaceId: string; displayName: string }> = [];
  const application = createApplication(renames);
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.identity = { tenantId, userId: LOCAL_USER_ID, role: "owner", permissions: [] };
    request.applications = { sessions: application } as unknown as RequestApplications;
    (request as { container?: unknown }).container = { deploymentKind };
  });
  await app.register(registerSessionRoutes, {
    prefix: "/api/agent",
    resolveSessionApplication: async () => application,
  } as unknown as AgentRouteOptions);
  return { app, renames };
}

describe("workspace rename route", () => {
  it("renames a workspace and echoes the updated display name", async () => {
    const { app, renames } = await createApp("local");
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/agent/workspaces/workspace-alpha",
        payload: { display_name: "新名称" },
      });
      expect(response.statusCode).toBe(200);
      expect(renames).toEqual([{ workspaceId: "workspace-alpha", displayName: "新名称" }]);

      const body = response.json();
      expect(body.data).toEqual({
        workspace_id: "workspace-alpha",
        display_name: "新名称",
        root_path: "D:/alpha",
      });
    } finally {
      await app.close();
    }
  });

  it("masks root_path on non-local deployments and returns 404 for missing workspaces", async () => {
    const { app } = await createApp("saas");
    try {
      const masked = await app.inject({
        method: "PATCH",
        url: "/api/agent/workspaces/workspace-alpha",
        payload: { display_name: "renamed" },
      });
      expect(masked.statusCode).toBe(200);
      expect(masked.json().data.root_path).toBeNull();

      const missing = await app.inject({
        method: "PATCH",
        url: "/api/agent/workspaces/workspace-missing",
        payload: { display_name: "renamed" },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
