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
  const app = {
    getSession: async () => session,
    setMessageFeedback: async (input: { messageId: string; value: "up" | "down"; comment?: string | null }) => {
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

async function createApp() {
  const application = createFeedbackApplication();
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.identity = {
      tenantId: session.tenant_id,
      userId: LOCAL_USER_ID,
      role: "owner",
      permissions: [],
    };
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
