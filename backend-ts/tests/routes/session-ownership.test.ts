import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createUserId, type RequestIdentity } from "../../src/identity/types.js";
import type { IdentityProvider } from "../../src/services/identity/index.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../src/services/identity/index.js";
import { buildTestHarness } from "../helpers/app.js";

const USER_A = createUserId("usr_owner_a");
const USER_B = createUserId("usr_owner_b");

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("session ownership", () => {
  it("returns 403 when another user in the same tenant accesses the session", async () => {
    const identityProvider: IdentityProvider = {
      async resolve(request: FastifyRequest): Promise<RequestIdentity> {
        const userId = request.headers["x-test-user"] === "b" ? USER_B : USER_A;
        return { userId, tenantId: LOCAL_TENANT_ID, role: "member", permissions: [] };
      },
    };
    const harness = await buildTestHarness({ identityProvider });
    app = harness.app;
    harness.controlStore.createTenant({ id: LOCAL_TENANT_ID, displayName: "Local" });
    const spoofedCreate = await app.inject({
      method: "POST",
      url: "/api/agent/sessions",
      headers: { "x-test-user": "a" },
      payload: { session_id: "spoofed-session", user_id: USER_B },
    });
    expect(spoofedCreate.statusCode).toBe(400);
    harness.container.sessionApplication.createSession({
      tenantId: LOCAL_TENANT_ID,
      sessionId: "private-session",
      userId: USER_A,
    });

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/private-session",
      headers: { "x-test-user": "b" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "forbidden" });

    const ownerUpdate = await app.inject({
      method: "PATCH",
      url: "/api/agent/sessions/private-session/permissions",
      headers: { "x-test-user": "a" },
      payload: { mode: "relaxed" },
    });
    expect(ownerUpdate.statusCode).toBe(200);
    const foreignUpdate = await app.inject({
      method: "PATCH",
      url: "/api/agent/sessions/private-session/permissions",
      headers: { "x-test-user": "b" },
      payload: { mode: "standard" },
    });
    expect(foreignUpdate.statusCode).toBe(403);
    expect(harness.container.conversationStore.getSession("private-session")?.permission_mode).toBe("relaxed");
  });

  it("allows local identity to access a historical null-owner session", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    harness.container.conversationStore.createSession(LOCAL_TENANT_ID, "legacy-local-null", null, {});

    const response = await app.inject({ method: "GET", url: "/api/agent/sessions/legacy-local-null" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { session_id: "legacy-local-null", user_id: null } });
    expect(LOCAL_USER_ID).toBe("usr_local");
  });

  it("bot owner 可查看 owned-bot 会话详情与列表", async () => {
    const harness = await buildOwnershipHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: USER_A, displayName: "Owner A Bot" });
    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "owned-bot-session", userId: bot.id });

    const detail = await app.inject({ method: "GET", url: "/api/agent/sessions/owned-bot-session", headers: { "x-test-user": "a" } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ data: { session_id: "owned-bot-session", user_id: bot.id } });
    const permissionUpdate = await app.inject({
      method: "PATCH",
      url: "/api/agent/sessions/owned-bot-session/permissions",
      headers: { "x-test-user": "a" },
      payload: { mode: "relaxed" },
    });
    expect(permissionUpdate.statusCode).toBe(200);
    expect(harness.container.conversationStore.getSession("owned-bot-session")?.permission_mode).toBe("relaxed");
    const listed = await app.inject({ method: "GET", url: "/api/agent/sessions", headers: { "x-test-user": "a" } });
    expect(listed.json().data.items).toEqual([expect.objectContaining({ session_id: "owned-bot-session", user_id: bot.id })]);
  });

  it("非 owner 无法查看其他用户 bot 的会话", async () => {
    const harness = await buildOwnershipHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: USER_A, displayName: "Owner A Bot" });
    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "foreign-bot-session", userId: bot.id });

    const detail = await app.inject({ method: "GET", url: "/api/agent/sessions/foreign-bot-session", headers: { "x-test-user": "b" } });
    expect(detail.statusCode).toBe(403);
    const permissionUpdate = await app.inject({
      method: "PATCH",
      url: "/api/agent/sessions/foreign-bot-session/permissions",
      headers: { "x-test-user": "b" },
      payload: { mode: "relaxed" },
    });
    expect(permissionUpdate.statusCode).toBe(403);
    const listed = await app.inject({ method: "GET", url: "/api/agent/sessions", headers: { "x-test-user": "b" } });
    expect(listed.json().data.items).toEqual([]);
  });
});

async function buildOwnershipHarness() {
  const identityProvider: IdentityProvider = {
    async resolve(request: FastifyRequest): Promise<RequestIdentity> {
      const userId = request.headers["x-test-user"] === "b" ? USER_B : USER_A;
      return { userId, tenantId: LOCAL_TENANT_ID, role: "member", permissions: [] };
    },
  };
  const harness = await buildTestHarness({ identityProvider });
  harness.controlStore.createTenant({ id: LOCAL_TENANT_ID, displayName: "Local" });
  harness.controlStore.createUser({ id: USER_A, displayName: "Owner A" });
  harness.controlStore.createUser({ id: USER_B, displayName: "Owner B" });
  harness.controlStore.upsertMembership({ userId: USER_A, tenantId: LOCAL_TENANT_ID, role: "member" });
  harness.controlStore.upsertMembership({ userId: USER_B, tenantId: LOCAL_TENANT_ID, role: "member" });
  return harness;
}
