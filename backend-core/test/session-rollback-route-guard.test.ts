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
  session_id: "session-rollback",
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

async function createApp(busy: boolean) {
  const rollbackCalls: Array<{ afterSeq?: number | null; afterMessageId?: string | null }> = [];
  const sessionsApp = {
    getSession: async (sessionId: string) => (sessionId === session.session_id ? session : null),
    rollbackMessages: async (input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }) => {
      rollbackCalls.push({ afterSeq: input.afterSeq ?? null, afterMessageId: input.afterMessageId ?? null });
      return 2;
    },
  } as unknown as SessionApplication;
  const executionApp = {
    isSessionBusy: async () => busy,
  } as unknown as RequestApplications["execution"];
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.identity = { tenantId: session.tenant_id, userId: LOCAL_USER_ID, role: "owner", permissions: [] };
    request.applications = { sessions: sessionsApp, execution: executionApp } as unknown as RequestApplications;
  });
  await app.register(registerSessionRoutes, {
    prefix: "/api/agent",
    resolveSessionApplication: async () => sessionsApp,
  } as unknown as AgentRouteOptions);
  return { app, rollbackCalls };
}

describe("session rollback route busy guard", () => {
  it("rejects rollback with 409 while the session has an active run, without touching messages", async () => {
    const { app, rollbackCalls } = await createApp(true);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/agent/sessions/${session.session_id}/rollback`,
        payload: { after_seq: 41 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "session_busy" });
      expect(rollbackCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("performs the rollback when the session is idle", async () => {
    const { app, rollbackCalls } = await createApp(false);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/agent/sessions/${session.session_id}/rollback`,
        payload: { after_seq: 41 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({ deleted: 2 });
      expect(rollbackCalls).toEqual([{ afterSeq: 41, afterMessageId: null }]);
    } finally {
      await app.close();
    }
  });
});
