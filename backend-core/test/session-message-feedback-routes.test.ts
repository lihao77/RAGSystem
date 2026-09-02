import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { registerSessionRoutes } from "../src/routes/agent/sessions.js";
import type { SessionApplication } from "../src/contracts/session/session-application.js";
import type { SessionInfo } from "../src/contracts/session/session.js";
import { computeSessionTeamRevision } from "../src/contracts/session/session.js";
import type { RequestApplications } from "../src/app/request-applications.js";
import type { AgentRouteOptions } from "../src/routes/route-options.js";
import { LOCAL_USER_ID } from "../src/services/identity/local-identity.js";
import { createTenantId } from "../src/identity/types.js";

const session: SessionInfo = {
  session_id: "session-feedback",
  team_snapshot: {
    team_name: "default",
    team_revision: computeSessionTeamRevision({}),
    entry_agent_name: "orchestrator_agent",
    agents: {},
  },
  tenant_id: createTenantId("tnt_test"),
  owner_user_id: "usr_test",
  visibility: "private",
  origin_type: "direct",
  origin_id: null,
  origin_channel: "web",
  workspace_id: null,
  permission_mode: null,
  metadata: {},
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

function createFeedbackApplication(): SessionApplication & {
  feedback: Map<string, "up" | "down">;
} {
  const feedback = new Map<string, "up" | "down">();
  const messages = new Map<string, string>([["message-a", "assistant"], ["message-b", "user"]]);
  const app = {
    getSession: async (sessionId: string) => (sessionId === session.session_id ? session : null),
    setMessageFeedback: async (input: { messageId: string; value: "up" | "down"; comment?: string | null }) => {
      if (messages.get(input.messageId) !== "assistant") return null;
      feedback.set(input.messageId, input.value);
      return {
        message_id: input.messageId,
        session_id: session.session_id,
        tenant_id: session.tenant_id,
        value: input.value,
        comment: input.comment ?? null,
        user_id: null,
        created_at: new Date(0).toISOString(),
        updated_at: new Date().toISOString(),
      };
    },
    clearMessageFeedback: async (input: { messageId: string }) => feedback.delete(input.messageId),
    // 故意返回完整存储 DTO（含 session_id/tenant_id/user_id）：GET 端点必须投影到
    // strict 的对外 schema，透传完整对象会被 validateResponse 拒绝（500）。
    listMessageFeedback: async () => [...feedback.entries()].map(([messageId, value]) => ({
      message_id: messageId,
      session_id: session.session_id,
      tenant_id: session.tenant_id,
      value,
      comment: null,
      user_id: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    })),
  } as unknown as SessionApplication & { feedback: Map<string, "up" | "down"> };
  return app;
}

// 钩子引用的可变身份：鉴权用例在测试内切换（默认 owner = LOCAL_USER_ID）
let identityForRequests = {
  tenantId: session.tenant_id,
  userId: LOCAL_USER_ID,
  role: "owner",
  permissions: [] as string[],
};

async function createApp() {
  const application = createFeedbackApplication();
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.identity = identityForRequests;
    // 仅预置 sessions 应用：反馈端点只消费它，避免为无关应用造假实现
    request.applications = { sessions: application } as unknown as RequestApplications;
  });
  await app.register(registerSessionRoutes, {
    prefix: "/api/agent",
    resolveSessionApplication: async () => application,
    // registry/identityProvider/wsTickets 由其余会话端点按需使用；反馈端点只消费
    // onRequest 预置的 request.applications 与 request.identity，故夹具不提供实体。
  } as unknown as AgentRouteOptions);
  return { app, application };
}

describe("session message feedback routes", () => {
  it("round-trips set, list, and clear feedback for an assistant message", async () => {
    const { app } = await createApp();
    try {
      const put = await app.inject({
        method: "PUT",
        url: "/api/agent/sessions/session-feedback/messages/message-a/feedback",
        payload: { value: "down", comment: "答非所问" },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().data).toMatchObject({ message_id: "message-a", value: "down", comment: "答非所问" });

      const list = await app.inject({ method: "GET", url: "/api/agent/sessions/session-feedback/messages/feedback" });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.items).toHaveLength(1);
      expect(list.json().data.items[0]).toMatchObject({ message_id: "message-a", value: "down" });

      const removed = await app.inject({
        method: "DELETE",
        url: "/api/agent/sessions/session-feedback/messages/message-a/feedback",
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().data).toEqual({ message_id: "message-a", cleared: true });

      const afterClear = await app.inject({ method: "GET", url: "/api/agent/sessions/session-feedback/messages/feedback" });
      expect(afterClear.json().data.items).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects unknown feedback values at the schema boundary", async () => {
    const { app } = await createApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/agent/sessions/session-feedback/messages/message-a/feedback",
        payload: { value: "meh" },
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });
});

describe("session message feedback access control", () => {
  it("rejects non-owner members and foreign tenants while keeping missing sessions 404", async () => {
    const { app } = await createApp();
    try {
      // 同租户非 owner 普通成员：private 会话不可读、不可写（LOCAL_USER_ID 之外的用户）
      await app.inject({ method: "PUT", url: "/api/agent/sessions/session-feedback/messages/message-a/feedback", payload: { value: "up" } });
      const previousIdentity = identityForRequests;
      identityForRequests = { tenantId: session.tenant_id, userId: "usr_other" as never, role: "member", permissions: [] };
      const forbiddenPut = await app.inject({ method: "PUT", url: "/api/agent/sessions/session-feedback/messages/message-a/feedback", payload: { value: "up" } });
      expect([403, 404]).toContain(forbiddenPut.statusCode);
      const forbiddenGet = await app.inject({ method: "GET", url: "/api/agent/sessions/session-feedback/messages/feedback" });
      expect([403, 404]).toContain(forbiddenGet.statusCode);
      identityForRequests = previousIdentity;

      // 租户不匹配：资源对跨租户请求表现为不存在
      identityForRequests = { tenantId: "tnt_other" as never, userId: LOCAL_USER_ID as never, role: "owner", permissions: [] };
      const foreignGet = await app.inject({ method: "GET", url: "/api/agent/sessions/session-feedback/messages/feedback" });
      expect(foreignGet.statusCode).toBe(404);
      identityForRequests = previousIdentity;

      // 会话不存在：404 而非 500
      const missingSession = await app.inject({ method: "GET", url: "/api/agent/sessions/no-such-session/messages/feedback" });
      expect(missingSession.statusCode).toBe(404);

      // 应用层判定消息不可评价（非助手消息/不存在）→ 404
      const notRateable = await app.inject({ method: "PUT", url: "/api/agent/sessions/session-feedback/messages/missing-message/feedback", payload: { value: "up" } });
      expect(notRateable.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
