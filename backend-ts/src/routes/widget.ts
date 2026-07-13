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
 * - POST /auth/token：app-key/secret → 短时 JWT（嵌入方服务端调，secret 路径）。
 * - POST /sessions：双鉴权单端点——Bearer JWT（secret 路径，服务端集成）
 *   或 X-Widget-Key + Origin 白名单（publishable key 路径，前端嵌入零宿主后端）。
 *   写 widget 上下文进 metadata，created_via 区分 "widget" / "widget_public"。
 *
 * 两条路径的鉴权大门不同：
 * - secret→JWT：大门是 server-held secret（嵌入方服务端持 secret 换 token），token 走 WS query，15min TTL。
 * - publishable key：publishable key 是公钥会暴露，大门是 allowed_origins 白名单（靠浏览器同源策略
 *   保证 Origin 真实）。WS 凭证是 session_id + Origin header，无 token 过期。防跨站滥用，不防定向攻击
 *   （非浏览器可伪造 Origin），定向防护用 secret 路径。
 *
 * 仅当全局 WidgetAuthService 存在（配了 WIDGET_JWT_SECRET）时启用；否则整组端点返回 503，
 * 默认部署完全不受影响。鉴权只挂在本 plugin 内，不污染既有 /api/agent/* 零鉴权路由。
 */
export const registerWidgetRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const auth = options.widgetAuth;

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
    const { token, expires_at } = auth.issueToken(widgetApp);
    return ok({ token, expires_at, token_type: "Bearer" }, "widget token 签发成功");
  });

  app.post("/sessions", async (request) => {
    let appKey: string;
    let tenantId;
    let createdVia: "widget" | "widget_public";
    try {
      if (request.headers.authorization) {
        const claims = auth.requireBearer(request);
        appKey = claims.sub;
        tenantId = claims.tenant_id;
        createdVia = "widget";
      } else {
        const publishableKey = request.headers["x-widget-key"];
        if (typeof publishableKey !== "string" || !publishableKey) {
          throw new WidgetAuthError("missing widget credentials");
        }
        const widgetApp = auth.verifyPublishableSession({ appKey: publishableKey, origin: request.headers.origin });
        appKey = widgetApp.app_key;
        tenantId = widgetApp.tenant_id;
        createdVia = "widget_public";
      }
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
        app_key: appKey,
        host_tools: body.host_tools ?? [],
        created_via: createdVia,
      },
    };
    request.container.sessionApplication.createSession({
      tenantId,
      sessionId,
      userId: `widget:${appKey}`,
      metadata,
    });
    return ok({ session_id: sessionId }, "widget 会话创建成功");
  });
};
