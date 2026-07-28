import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { ok } from "@ragsystem/backend-core/contracts/common.js";
import type { SessionApplication } from "@ragsystem/backend-core/contracts/session/session-application.js";
import type { WsTicketService } from "@ragsystem/backend-core/services/runtime/ws-ticket-service.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { WidgetCreateSessionRequestSchema, WidgetTokenRequestSchema } from "../contracts/widget.js";
import { widgetUserId } from "../identity/widget-user-id.js";
import { WidgetAuthError, type WidgetAuthService } from "../services/widget-auth-service.js";

interface WidgetSessionParams {
  sessionId: string;
}

/**
 * widget 第三方嵌入接入面（prefix /api/widget）。
 *
 * - POST /auth/token：app-key/secret → 短时 JWT（嵌入方服务端调，secret 路径）。
 * - POST /sessions：双鉴权单端点——Bearer JWT（secret 路径，服务端集成）
 *   或 X-Widget-Key + Origin 白名单（publishable key 路径，前端嵌入零宿主后端）。
 *   来源和 app key 写入 Session 一等字段；metadata 只保留非身份执行配置。
 *
 * 两条路径的鉴权大门不同：
 * - secret→JWT：大门是 server-held secret；15min JWT 只用于 HTTP，WS 每次另签 60s 单次 ticket。
 * - publishable key：publishable key 是公钥会暴露，大门是 allowed_origins 白名单（靠浏览器同源策略
 *   保证 Origin 真实）。通过 HTTP 校验 Origin 后签发 session-scoped WS ticket。防跨站滥用，不防定向攻击
 *   （非浏览器可伪造 Origin），定向防护用 secret 路径。
 *
 * 仅当全局 WidgetAuthService 存在（配置了 Widget key ring）时启用；否则整组端点返回 503，
 * 默认部署完全不受影响。鉴权只挂在本 plugin 内，不污染既有 /api/agent/* 零鉴权路由。
 */
export interface WidgetRouteOptions {
  widgetAuth?: WidgetAuthService;
  wsTickets: WsTicketService;
  resolveSessionApplication(request: Parameters<WidgetAuthService["requireBearer"]>[0]): SessionApplication | undefined | Promise<SessionApplication | undefined>;
}

export const registerWidgetRoutes: FastifyPluginAsync<WidgetRouteOptions> = async (app, options) => {
  const auth = options.widgetAuth;

  if (!auth) {
    const disabled = async (): Promise<never> => {
      throw new HttpError(503, "widget_disabled", "未配置 WIDGET_JWT_KEY_RING，widget 接入未启用");
    };
    app.post("/auth/token", { config: { auth: "public" } }, disabled);
    app.post("/sessions", disabled);
    app.post("/sessions/:sessionId/ws-ticket", disabled);
    return;
  }

  app.post("/auth/token", { config: { auth: "public" } }, async (request) => {
    const body = WidgetTokenRequestSchema.parse(request.body);
    const widgetApp = await auth.verifyAppCredentials(body.app_key, body.secret);
    if (!widgetApp) {
      throw new HttpError(401, "unauthorized", "app_key 或 secret 无效");
    }
    const { token, expires_at } = await auth.issueToken(widgetApp);
    return ok({ token, expires_at, token_type: "Bearer" }, "widget token 签发成功");
  });

  app.post("/sessions", async (request) => {
    const { appKey, tenantId, createdVia } = await resolveWidgetCredential(request, auth);
    const body = WidgetCreateSessionRequestSchema.parse(request.body);
    const sessionId = randomUUID();
    const metadata = { ...(body.metadata ?? {}), host_tools: body.host_tools ?? [], entry_channel: createdVia };
    const sessions = await requireSessionApplication(options, request);
    await sessions.createSession({
      sessionId, ownerUserId: null, visibility: "tenant", originType: "widget",
      originId: appKey, originChannel: createdVia === "widget_public" ? "widget_embed" : "widget_api",
      workspaceId: null, metadata, permissionMode: null,
    });
    return ok({ session_id: sessionId }, "widget 会话创建成功");
  });

  app.post<{ Params: WidgetSessionParams }>("/sessions/:sessionId/ws-ticket", async (request) => {
    const { appKey, tenantId } = await resolveWidgetCredential(request, auth);
    const sessions = await requireSessionApplication(options, request);
    const session = await sessions.getSession(request.params.sessionId);
    if (!session || session.tenant_id !== tenantId || session.origin_type !== "widget" || session.origin_id !== appKey) {
      throw new HttpError(404, "not_found", "会话不存在");
    }
    return ok(await options.wsTickets.issue({
      userId: widgetUserId(appKey), tenantId, role: "widget", permissions: [],
      originPrincipal: { type: "widget", id: appKey },
    }, request.params.sessionId), "Widget WebSocket ticket 已签发");
  });
};

async function resolveWidgetCredential(
  request: Parameters<WidgetAuthService["requireBearer"]>[0],
  auth: WidgetAuthService,
): Promise<{ appKey: string; tenantId: TenantId; createdVia: "widget" | "widget_public" }> {
  try {
    if (request.headers.authorization) {
      const claims = await auth.requireBearer(request);
      return { appKey: claims.sub, tenantId: claims.tenant_id, createdVia: "widget" };
    }
    const publishableKey = request.headers["x-widget-key"];
    if (typeof publishableKey !== "string" || !publishableKey) throw new WidgetAuthError("missing widget credentials");
    const widgetApp = await auth.verifyPublishableSession({ appKey: publishableKey, origin: request.headers.origin });
    return { appKey: widgetApp.app_key, tenantId: widgetApp.tenant_id, createdVia: "widget_public" };
  } catch (error) {
    if (error instanceof WidgetAuthError) throw new HttpError(401, "unauthorized", error.message);
    throw error;
  }
}

async function requireSessionApplication(
  options: WidgetRouteOptions,
  request: Parameters<WidgetAuthService["requireBearer"]>[0],
): Promise<SessionApplication> {
  const application = await options.resolveSessionApplication(request);
  if (!application) throw new Error("session application resolver returned no implementation");
  return application;
}
