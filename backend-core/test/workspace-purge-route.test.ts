import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { registerSessionRoutes } from "../src/routes/agent/sessions.js";
import type { SessionApplication } from "../src/contracts/session/session-application.js";
import type { SessionInfo, SessionListProjection } from "../src/contracts/session/session.js";
import { computeSessionTeamRevision } from "../src/contracts/session/session.js";
import type { RequestApplications } from "../src/app/request-applications.js";
import type { AgentRouteOptions } from "../src/routes/route-options.js";
import { LOCAL_USER_ID } from "../src/services/identity/local-identity.js";
import { createTenantId, type RequestIdentity } from "../src/identity/types.js";

const TENANT_ID = createTenantId("tnt_purge");
const WORKSPACE_ID = "ws_purge";

function makeSession(input: {
  sessionId: string;
  ownerUserId: string;
  workspaceId: string | null;
  visibility?: "private" | "tenant";
  originType?: "direct" | "bot" | "widget";
  originId?: string | null;
}): SessionInfo {
  return {
    session_id: input.sessionId,
    team_snapshot: {
      team_name: "default",
      team_revision: computeSessionTeamRevision({}),
      entry_agent_name: "orchestrator_agent",
      agents: {},
    },
    tenant_id: TENANT_ID,
    owner_user_id: input.ownerUserId,
    visibility: input.visibility ?? "private",
    origin_type: input.originType ?? "direct",
    origin_id: input.originId ?? null,
    origin_channel: "web",
    workspace_id: input.workspaceId,
    permission_mode: null,
    metadata: {},
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

function toProjection(session: SessionInfo, activityAt: string): SessionListProjection & { activity_at: string } {
  return {
    session_id: session.session_id,
    tenant_id: session.tenant_id,
    owner_user_id: session.owner_user_id,
    visibility: session.visibility,
    origin_type: session.origin_type,
    origin_id: session.origin_id,
    origin_channel: session.origin_channel,
    workspace_id: session.workspace_id,
    title: session.session_id,
    last_message: "",
    first_message: "",
    unread_count: 0,
    activity_at: activityAt,
  };
}

interface PurgeFixture {
  app: ReturnType<typeof Fastify>;
  sessions: Map<string, SessionInfo & { activity_at: string }>;
  deleted: string[];
  removeWorkspaceCalls: string[];
}

async function createApp(
  extraSessions: (SessionInfo & { activity_at: string })[] = [],
  vanishIds: Set<string> = new Set(),
): Promise<PurgeFixture> {
  const sessions = new Map<string, SessionInfo & { activity_at: string }>();
  sessions.set("ws-a-1", { ...makeSession({ sessionId: "ws-a-1", ownerUserId: LOCAL_USER_ID, workspaceId: WORKSPACE_ID }), activity_at: "2024-01-03T00:00:00.000Z" });
  sessions.set("ws-a-2", { ...makeSession({ sessionId: "ws-a-2", ownerUserId: LOCAL_USER_ID, workspaceId: WORKSPACE_ID }), activity_at: "2024-01-02T00:00:00.000Z" });
  sessions.set("ws-a-3", { ...makeSession({ sessionId: "ws-a-3", ownerUserId: LOCAL_USER_ID, workspaceId: WORKSPACE_ID }), activity_at: "2024-01-01T00:00:00.000Z" });
  sessions.set("outside-1", { ...makeSession({ sessionId: "outside-1", ownerUserId: LOCAL_USER_ID, workspaceId: null }), activity_at: "2024-01-05T00:00:00.000Z" });
  for (const extra of extraSessions) sessions.set(extra.session_id, extra);

  const deleted: string[] = [];
  const removeWorkspaceCalls: string[] = [];
  // 仿 SQLite listSessions：workspace 过滤 + 可见性（includeTenant 才看全租户）+ keyset 游标
  // （activity_at, session_id）值比较，与真实 SQL 一致而非按位置翻页。页大小压到 2，验证路由端翻页取尽。
  const PAGE_SIZE = 2;
  const application = {
    listSessions: async (input: { access: { userId: string; includeTenant: boolean }; workspaceId?: string | null; cursor?: { activityAt: string; sessionId: string } | null }) => {
      let visible = [...sessions.values()].filter((session) => (input.workspaceId ? session.workspace_id === input.workspaceId : true));
      visible = visible.filter((session) => input.access.includeTenant || session.owner_user_id === input.access.userId || session.visibility === "tenant");
      visible.sort((a, b) => (a.activity_at === b.activity_at ? (a.session_id < b.session_id ? 1 : -1) : a.activity_at < b.activity_at ? 1 : -1));
      const cursor = input.cursor;
      if (cursor) {
        visible = visible.filter((session) => session.activity_at < cursor.activityAt
          || (session.activity_at === cursor.activityAt && session.session_id < cursor.sessionId));
      }
      const page = visible.slice(0, PAGE_SIZE);
      const last = page.at(-1);
      return {
        items: page.map((session) => toProjection(session, session.activity_at)),
        nextCursor: page.length === PAGE_SIZE && last ? { activityAt: last.activity_at, sessionId: last.session_id } : null,
      };
    },
    getSession: async (sessionId: string) => sessions.get(sessionId) ?? null,
    deleteSession: async (sessionId: string) => {
      if (!sessions.delete(sessionId)) return false;
      // 模拟并发竞争：行已消失（他人已删），本主体删了个空 → 路由不应记入任何一侧
      if (vanishIds.has(sessionId)) return false;
      deleted.push(sessionId);
      return true;
    },
    removeWorkspace: async (workspaceId: string) => {
      removeWorkspaceCalls.push(workspaceId);
      return workspaceId === WORKSPACE_ID;
    },
  } as unknown as SessionApplication;

  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.identity = identityForRequests;
    request.applications = { sessions: application } as unknown as RequestApplications;
  });
  await app.register(registerSessionRoutes, {
    prefix: "/api/agent",
    resolveSessionApplication: async () => application,
  } as unknown as AgentRouteOptions);
  return { app, sessions, deleted, removeWorkspaceCalls };
}

// 默认本地主体：LOCAL_USER_ID 对本租户全部会话可变更
let identityForRequests: RequestIdentity = {
  tenantId: TENANT_ID,
  userId: LOCAL_USER_ID,
  role: "owner",
  permissions: [],
};

describe("workspace purge route (DELETE /workspaces/:id?delete_sessions=true)", () => {
  it("删除项目下全部会话（含跨页）并移除项目，不触碰其他项目", async () => {
    const { app, sessions, deleted, removeWorkspaceCalls } = await createApp();
    try {
      const response = await app.inject({ method: "DELETE", url: `/api/agent/workspaces/${WORKSPACE_ID}?delete_sessions=true` });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({
        deleted_session_ids: ["ws-a-1", "ws-a-2", "ws-a-3"],
        failed: [],
      });
      expect(deleted).toEqual(["ws-a-1", "ws-a-2", "ws-a-3"]);
      expect(removeWorkspaceCalls).toEqual([WORKSPACE_ID]);
      expect(sessions.has("outside-1")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("不可变更的会话记入 failed 且不阻断项目移除", async () => {
    // widget 机器人主体：能列出自己名下的会话（owner 匹配），
    // 但 canAccessAsHumanPrincipal 对 originPrincipal 一律拒绝 → 不可删。
    const botSession = {
      ...makeSession({ sessionId: "ws-a-bot", ownerUserId: "usr_bot", workspaceId: WORKSPACE_ID, originType: "widget", originId: "widget-1" }),
      activity_at: "2024-01-04T00:00:00.000Z",
    };
    const { app, deleted, removeWorkspaceCalls } = await createApp([botSession]);
    identityForRequests = {
      tenantId: TENANT_ID,
      userId: "usr_bot" as never,
      role: "member",
      permissions: [],
      originPrincipal: { type: "widget", id: "widget-1" },
    };
    try {
      const response = await app.inject({ method: "DELETE", url: `/api/agent/workspaces/${WORKSPACE_ID}?delete_sessions=true` });
      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      expect(data.deleted_session_ids).toEqual([]);
      expect(data.failed).toHaveLength(1);
      expect(data.failed[0].session_id).toBe("ws-a-bot");
      expect(data.failed[0].reason).toBeTruthy();
      expect(deleted).toEqual([]);
      expect(removeWorkspaceCalls).toEqual([WORKSPACE_ID]);
    } finally {
      identityForRequests = {
        tenantId: TENANT_ID,
        userId: LOCAL_USER_ID,
        role: "owner",
        permissions: [],
      };
      await app.close();
    }
  });

  it("不带 delete_sessions 参数时保持原行为：不动会话", async () => {
    const { app, deleted, removeWorkspaceCalls } = await createApp();
    try {
      const response = await app.inject({ method: "DELETE", url: `/api/agent/workspaces/${WORKSPACE_ID}` });
      expect(response.statusCode).toBe(200);
      expect(deleted).toEqual([]);
      expect(removeWorkspaceCalls).toEqual([WORKSPACE_ID]);
    } finally {
      await app.close();
    }
  });

  it("delete_sessions=1 与 true 等价（含大写归一化）", async () => {
    const { app, deleted } = await createApp();
    try {
      const response = await app.inject({ method: "DELETE", url: `/api/agent/workspaces/${WORKSPACE_ID}?delete_sessions=1` });
      expect(response.statusCode).toBe(200);
      expect(deleted).toEqual(["ws-a-1", "ws-a-2", "ws-a-3"]);

      const upper = await createApp();
      try {
        const upperResponse = await upper.app.inject({ method: "DELETE", url: `/api/agent/workspaces/${WORKSPACE_ID}?delete_sessions=TRUE` });
        expect(upperResponse.statusCode).toBe(200);
        expect(upper.deleted).toEqual(["ws-a-1", "ws-a-2", "ws-a-3"]);
      } finally {
        await upper.app.close();
      }
    } finally {
      await app.close();
    }
  });

  it("并发竞争下已被删除的会话不重复计数", async () => {
    // ws-a-2 在列表与删除之间被他人删掉：行已消失、本主体删了个空 → 不进 deleted 也不进 failed
    const { app, sessions, deleted, removeWorkspaceCalls } = await createApp([], new Set(["ws-a-2"]));
    try {
      const response = await app.inject({ method: "DELETE", url: `/api/agent/workspaces/${WORKSPACE_ID}?delete_sessions=true` });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({
        deleted_session_ids: ["ws-a-1", "ws-a-3"],
        failed: [],
      });
      expect(deleted).toEqual(["ws-a-1", "ws-a-3"]);
      expect(removeWorkspaceCalls).toEqual([WORKSPACE_ID]);
      expect(sessions.has("ws-a-2")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("项目不存在时返回 404", async () => {
    const { app, deleted } = await createApp();
    try {
      const response = await app.inject({ method: "DELETE", url: "/api/agent/workspaces/ws_missing?delete_sessions=true" });
      expect(response.statusCode).toBe(404);
      expect(deleted).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
