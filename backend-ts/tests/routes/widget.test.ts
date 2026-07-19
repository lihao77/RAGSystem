import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestHarness } from "../helpers/app.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { widgetUserId } from "../../src/identity/widget-user-id.js";

const TEST_SECRET = "test-widget-secret-0123456789abcdef0123456789abcdef";

/** injectWS 返回的 socket 结构（@fastify/websocket WebSocket 的窄子集，免 import 类型）。 */
type WsLike = {
  readyState: number;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  terminate(): void;
};

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("widget auth routes", () => {
  it("issues a short-lived token for valid app credentials", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: TEST_SECRET });
    app = harness.app;
    const created = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID,
      display_name: "测试站点",
      allowed_origins: ["https://example.com"],
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/widget/auth/token",
      payload: { app_key: created.app_key, secret: created.secret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      data: { token: expect.any(String), token_type: "Bearer", expires_at: expect.any(Number) },
    });
  });

  it("rejects token issuance for invalid secret with 401", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: TEST_SECRET });
    app = harness.app;
    const created = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "测试站点" });

    const res = await app.inject({
      method: "POST",
      url: "/api/widget/auth/token",
      payload: { app_key: created.app_key, secret: "wrong-secret" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("issues a widget session with Bearer token and stamps widget metadata", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: TEST_SECRET });
    app = harness.app;
    const created = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "测试站点" });
    const tokenRes = await app.inject({
      method: "POST",
      url: "/api/widget/auth/token",
      payload: { app_key: created.app_key, secret: created.secret },
    });
    const token: string = tokenRes.json().data.token;

    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/widget/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: { host_tools: ["get_page_title"] },
    });
    expect(sessionRes.statusCode).toBe(200);
    const sessionId: string = sessionRes.json().data.session_id;
    const session = harness.container.sessionApplication.getSession(sessionId);
    expect(session?.user_id).toBe(widgetUserId(created.app_key));
    expect(session?.metadata).toMatchObject({
      widget: { app_key: created.app_key, host_tools: ["get_page_title"], created_via: "widget" },
    });
  });

  it("uses the deployment session application when SaaS session persistence is injected", async () => {
    const createdRows: Array<Record<string, unknown>> = [];
    const harness = await buildTestHarness({
      widgetJwtSecret: TEST_SECRET,
      resolveSessionApplication: async () => ({
        createSession: async (input: Record<string, unknown>) => {
          createdRows.push(input);
          return { session_id: input.sessionId, user_id: input.userId, metadata: input.metadata };
        },
        getSession: async () => null,
      }) as never,
    });
    app = harness.app;
    const created = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "SaaS widget" });
    const tokenRes = await app.inject({
      method: "POST",
      url: "/api/widget/auth/token",
      payload: { app_key: created.app_key, secret: created.secret },
    });

    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/widget/sessions",
      headers: { authorization: `Bearer ${tokenRes.json().data.token}` },
      payload: {},
    });

    expect(sessionRes.statusCode).toBe(200);
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toMatchObject({ metadata: { widget: { app_key: created.app_key } } });
    expect(harness.container.sessionApplication.getSession(sessionRes.json().data.session_id)).toBeNull();
  });

  it("rejects widget session creation without Bearer token with 401", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: TEST_SECRET });
    app = harness.app;
    const res = await app.inject({ method: "POST", url: "/api/widget/sessions", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("returns 503 when widget auth is not configured", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const res = await app.inject({
      method: "POST",
      url: "/api/widget/auth/token",
      payload: { app_key: "x", secret: "y" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("rejects WS connection to a widget session without token (close 4001)", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: TEST_SECRET });
    app = harness.app;
    const sessionId = await createWidgetSession(harness, []);

    const ws = (await app.injectWS(`/api/agent/sessions/${sessionId}/ws`, {}, {})) as unknown as WsLike;
    const closeInfo = await Promise.race([
      new Promise<{ code: number }>((resolve) => {
        ws.on("close", (code) => resolve({ code }));
      }),
      new Promise<{ code: number }>((resolve) => setTimeout(() => resolve({ code: -1 }), 2000)),
    ]);
    ws.terminate();
    expect(closeInfo.code).toBe(4001);
  });

  it("admits WS connection with a session ticket and rejects replay", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: TEST_SECRET });
    app = harness.app;
    const { token, sessionId } = await createWidgetSessionWithToken(harness, []);

    const ticketResponse = await app.inject({
      method: "POST",
      url: `/api/widget/sessions/${sessionId}/ws-ticket`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ticketResponse.statusCode).toBe(200);
    const ticket: string = ticketResponse.json().data.ticket;
    const path = `/api/agent/sessions/${sessionId}/ws?ticket=${encodeURIComponent(ticket)}`;
    const ws = (await app.injectWS(
      path,
      {},
      {},
    )) as unknown as WsLike;
    await new Promise((resolve) => setTimeout(resolve, 400));
    // 鉴权通过：连接保持 OPEN（readyState 1），未被 4001 关闭。
    expect(ws.readyState).toBe(1);
    ws.terminate();
    await expect(app.injectWS(path)).rejects.toThrow();
  });

  /** 建 widget app + 换 token + 签发 widget 会话（无 token 返回路径用）。 */
  async function createWidgetSessionWithToken(
    harness: Awaited<ReturnType<typeof buildTestHarness>>,
    hostTools: string[],
  ): Promise<{ token: string; sessionId: string }> {
    const created = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "ws-test" });
    const tokenRes = await app!.inject({
      method: "POST",
      url: "/api/widget/auth/token",
      payload: { app_key: created.app_key, secret: created.secret },
    });
    const token: string = tokenRes.json().data.token;
    const sessionId = await createWidgetSessionWithBearer(harness, token, hostTools);
    return { token, sessionId };
  }

  async function createWidgetSession(
    harness: Awaited<ReturnType<typeof buildTestHarness>>,
    hostTools: string[],
  ): Promise<string> {
    const created = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "ws-test" });
    const tokenRes = await app!.inject({
      method: "POST",
      url: "/api/widget/auth/token",
      payload: { app_key: created.app_key, secret: created.secret },
    });
    const token: string = tokenRes.json().data.token;
    return createWidgetSessionWithBearer(harness, token, hostTools);
  }

  async function createWidgetSessionWithBearer(
    harness: Awaited<ReturnType<typeof buildTestHarness>>,
    token: string,
    hostTools: string[],
  ): Promise<string> {
    void harness;
    const sessionRes = await app!.inject({
      method: "POST",
      url: "/api/widget/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: hostTools.length > 0 ? { host_tools: hostTools } : {},
    });
    return sessionRes.json().data.session_id as string;
  }
});
