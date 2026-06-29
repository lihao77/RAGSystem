import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { ok } from "../contracts/common.js";
import { WidgetCreateSessionRequestSchema, WidgetTokenRequestSchema } from "../contracts/widget.js";
import { WidgetAuthError } from "../services/runtime/jwt-service.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

/**
 * widget 第三方嵌入接入面（prefix /api/widget）。
 *
 * - POST /auth/token：app-key/secret → 短时 JWT（嵌入方服务端调）。
 * - POST /sessions：Bearer JWT → 受约束会话（写 widget 上下文进 metadata）。
 *
 * 仅当 RuntimeContainer.widgetAuth 存在（配了 WIDGET_JWT_SECRET）时启用；否则整组端点返回 503，
 * 默认部署完全不受影响。鉴权只挂在本 plugin 内，不污染既有 /api/agent/* 零鉴权路由。
 *
 * 鉴权边界说明：真正的大门是 server-held secret（嵌入方服务端持 app-key/secret 换 token）。
 * CORS / per-app allowed_origins 不构成有效隔离——嵌入方服务端调用无 Origin 头（CORS 不 gate），
 * 浏览器仅持 token 开 WS（WS 不受 CORS 约束）。token 走 WS query，生产须 HTTPS + 短 TTL(15min)。
 */
export const registerWidgetRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const container = options.container;
  const auth = container.widgetAuth;

  if (!auth) {
    const disabled = async (): Promise<never> => {
      throw new HttpError(503, "widget_disabled", "未配置 WIDGET_JWT_SECRET，widget 接入未启用");
    };
    app.post("/auth/token", disabled);
    app.post("/sessions", disabled);
    return;
  }

  app.post("/auth/token", async (request) => {
    const body = WidgetTokenRequestSchema.parse(request.body);
    const widgetApp = auth.verifyAppCredentials(body.app_key, body.secret);
    if (!widgetApp) {
      throw new HttpError(401, "unauthorized", "app_key 或 secret 无效");
    }
    const { token, expires_at } = auth.issueToken(widgetApp.app_key);
    return ok({ token, expires_at, token_type: "Bearer" }, "widget token 签发成功");
  });

  app.post("/sessions", async (request) => {
    let claims;
    try {
      claims = auth.requireBearer(request);
    } catch (error) {
      if (error instanceof WidgetAuthError) {
        throw new HttpError(401, "unauthorized", error.message);
      }
      throw error;
    }
    const body = WidgetCreateSessionRequestSchema.parse(request.body);
    const sessionId = randomUUID();
    const metadata = {
      ...(body.metadata ?? {}),
      widget: {
        app_key: claims.sub,
        host_tools: body.host_tools ?? [],
        created_via: "widget" as const,
      },
    };
    container.sessionApplication.createSession({
      sessionId,
      userId: `widget:${claims.sub}`,
      metadata,
    });
    return ok({ session_id: sessionId }, "widget 会话创建成功");
  });
};
