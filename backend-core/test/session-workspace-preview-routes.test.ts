import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { registerSessionRoutes } from "../src/routes/agent/sessions.js";
import type { SessionApplication } from "../src/contracts/session/session-application.js";
import type { SessionListProjection, SessionListProjectionPage } from "../src/contracts/session/session.js";
import type { RequestApplications } from "../src/app/request-applications.js";
import type { AgentRouteOptions } from "../src/routes/route-options.js";
import { LOCAL_USER_ID } from "../src/services/identity/local-identity.js";
import { createTenantId } from "../src/identity/types.js";

const tenantId = createTenantId("tnt_test");

function projection(sessionId: string, workspaceId: string | null, activityAt: string): SessionListProjection {
  return {
    session_id: sessionId,
    tenant_id: tenantId,
    owner_user_id: "usr_test",
    visibility: "private",
    origin_type: "direct",
    origin_id: null,
    origin_channel: "web",
    workspace_id: workspaceId,
    title: sessionId,
    last_message: "",
    activity_at: activityAt,
    first_message: "",
    unread_count: 0,
  };
}

interface ListCall {
  workspaceId: string | null;
  limit: number;
}

function createApplication() {
  const calls: ListCall[] = [];
  const pages = new Map<string, SessionListProjectionPage>([
    ["workspace-alpha", {
      items: [projection("alpha-1", "workspace-alpha", "2026-07-26T12:00:00.000Z")],
      nextCursor: { activityAt: "2026-07-26T12:00:00.000Z", sessionId: "alpha-1" },
    }],
    ["workspace-empty", { items: [], nextCursor: null }],
    // __unassigned__：持久层把哨兵翻译为 workspace IS NULL
    ["__unassigned__", {
      items: [projection("unassigned-1", null, "2026-07-26T11:00:00.000Z")],
      nextCursor: null,
    }],
  ]);
  const application = {
    listWorkspaces: async () => [
      { workspace_id: "workspace-alpha", display_name: "alpha", root_path: "D:/alpha" },
      { workspace_id: "workspace-empty", display_name: "empty", root_path: "D:/empty" },
    ],
    listWorkspacesByIds: async (ids: readonly string[]) => ids.map((id) => (
      id === "workspace-alpha"
        ? { workspace_id: "workspace-alpha", display_name: "alpha", root_path: "D:/alpha" }
        : { workspace_id: "workspace-empty", display_name: "empty", root_path: "D:/empty" }
    )),
    listSessions: async (input: { workspaceId?: string | null; limit: number }) => {
      const workspaceId = input.workspaceId ?? "__unassigned__";
      calls.push({ workspaceId, limit: input.limit });
      const page = pages.get(workspaceId) ?? { items: [], nextCursor: null };
      return { items: page.items.slice(0, input.limit), nextCursor: page.nextCursor };
    },
  };
  return { application: application as unknown as SessionApplication, calls };
}

async function createApp() {
  const { application, calls } = createApplication();
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.identity = { tenantId, userId: LOCAL_USER_ID, role: "owner", permissions: [] };
    request.applications = { sessions: application } as unknown as RequestApplications;
    // assembleSessionList 依据 deploymentKind 决定是否暴露 root_path
    (request as { container?: unknown }).container = { deploymentKind: "local" };
  });
  await app.register(registerSessionRoutes, {
    prefix: "/api/agent",
    resolveSessionApplication: async () => application,
  } as unknown as AgentRouteOptions);
  return { app, calls };
}

describe("session workspace preview route", () => {
  it("returns each workspace first page plus the unassigned group with per-group cursors", async () => {
    const { app, calls } = await createApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/agent/sessions/workspace-preview" });
      expect(response.statusCode).toBe(200);

      // 每个注册项目 + 未归属组各查一页，limit 默认 5
      expect(calls.map((call) => call.workspaceId).sort()).toEqual(["__unassigned__", "workspace-alpha", "workspace-empty"]);
      expect(calls.every((call) => call.limit === 5)).toBe(true);

      const groups = response.json().data.groups as Array<{
        workspace_id: string;
        items: Array<{ session_id: string; workspace: { workspace_id: string } | null }>;
        next_cursor: string | null;
      }>;
      expect(groups).toHaveLength(3);

      const alpha = groups.find((group) => group.workspace_id === "workspace-alpha");
      expect(alpha?.items).toHaveLength(1);
      expect(alpha?.items[0]?.workspace?.workspace_id).toBe("workspace-alpha");
      expect(typeof alpha?.next_cursor).toBe("string");

      const empty = groups.find((group) => group.workspace_id === "workspace-empty");
      expect(empty?.items).toHaveLength(0);
      expect(empty?.next_cursor).toBeNull();

      const unassigned = groups.find((group) => group.workspace_id === "__unassigned__");
      expect(unassigned?.items).toHaveLength(1);
      expect(unassigned?.items[0]?.workspace).toBeNull();
      expect(unassigned?.next_cursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("honors the per-group limit and rejects origin_id without a specific origin_type", async () => {
    const { app } = await createApp();
    try {
      const limited = await app.inject({ method: "GET", url: "/api/agent/sessions/workspace-preview?limit=2" });
      expect(limited.statusCode).toBe(200);

      const invalid = await app.inject({ method: "GET", url: "/api/agent/sessions/workspace-preview?origin_id=bot-1" });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
