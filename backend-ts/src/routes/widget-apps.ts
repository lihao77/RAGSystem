import type { FastifyPluginAsync } from "fastify";

import { CreatedWidgetAppViewSchema, CreateWidgetAppRequestSchema, UpdateWidgetAppRequestSchema, WidgetAppViewSchema, WidgetAuditViewSchema, WidgetTokenViewSchema } from "../contracts/widget.js";
import type { CreatedWidgetApp, WidgetApp } from "../services/stores/widget-credential-store/index.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface AppParams { key: string; }
interface TokenParams extends AppParams { jti: string; }
interface AuditQuery { limit?: string; offset?: string; }

export const registerWidgetAppsRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const store = options.container.widgetCredentialStore;
  if (!options.container.widgetAuth || !store) {
    const disabled = async () => { throw new HttpError(503, "widget_disabled", "未配置 WIDGET_JWT_SECRET，widget 接入未启用"); };
    app.all("/", disabled);
    app.all("/*", disabled);
    return;
  }

  app.get("/", async () => ({ success: true, apps: store.ops.listApps().map(toAppView) }));
  app.post("/", async (request) => {
    const body = CreateWidgetAppRequestSchema.parse(request.body);
    const created = store.ops.createApp(body);
    store.audit.record({ app_key: created.app_key, action: "create", actor: "console", detail: { display_name: created.display_name, allowed_origins: created.allowed_origins } });
    return { success: true, app: toCreatedView(created) };
  });
  app.get<{ Params: AppParams }>("/:key", async (request) => ({ success: true, app: toAppView(requireApp(store.ops.getApp(request.params.key))) }));
  app.patch<{ Params: AppParams }>("/:key", async (request) => {
    const body = UpdateWidgetAppRequestSchema.parse(request.body);
    const update = {
      ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
      ...(body.allowed_origins !== undefined ? { allowed_origins: body.allowed_origins } : {}),
    };
    const updated = store.ops.updateApp(request.params.key, update);
    if (!updated) throw new HttpError(404, "not_found", "widget app 不存在");
    store.audit.record({ app_key: updated.app_key, action: "update", actor: "console", detail: body });
    return { success: true, app: toAppView(updated) };
  });
  app.post<{ Params: AppParams }>("/:key/rotate-secret", async (request) => {
    const rotated = store.ops.rotateSecret(request.params.key);
    if (!rotated) throw new HttpError(404, "not_found", "widget app 不存在或已吊销");
    store.audit.record({ app_key: rotated.app_key, action: "rotate_secret", actor: "console" });
    return { success: true, app: toCreatedView(rotated) };
  });
  app.post<{ Params: AppParams }>("/:key/revoke", async (request) => {
    if (!store.ops.revokeApp(request.params.key)) throw new HttpError(404, "not_found", "widget app 不存在或已吊销");
    store.audit.record({ app_key: request.params.key, action: "revoke", actor: "console" });
    return { success: true, app: toAppView(requireApp(store.ops.getApp(request.params.key))) };
  });
  app.get<{ Params: AppParams }>("/:key/tokens", async (request) => ({ success: true, tokens: store.ops.listTokensByApp(request.params.key).map((token) => WidgetTokenViewSchema.parse(token)) }));
  app.delete<{ Params: TokenParams }>("/:key/tokens/:jti", async (request) => {
    requireApp(store.ops.getApp(request.params.key));
    if (!store.ops.listTokensByApp(request.params.key).some((token) => token.jti === request.params.jti)) throw new HttpError(404, "not_found", "widget token 不存在");
    store.ops.revokeToken(request.params.jti);
    store.audit.record({ app_key: request.params.key, action: "revoke_token", actor: "console", detail: { jti: request.params.jti } });
    return { success: true };
  });
  app.get<{ Params: AppParams; Querystring: AuditQuery }>("/:key/audit", async (request) => {
    requireApp(store.ops.getApp(request.params.key));
    const limit = parsePageValue(request.query.limit, 100, 1, 500);
    const offset = parsePageValue(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return { success: true, audit: store.audit.list(request.params.key, limit, offset).map((entry) => WidgetAuditViewSchema.parse(entry)) };
  });
};

function requireApp(app: WidgetApp | null): WidgetApp { if (!app) throw new HttpError(404, "not_found", "widget app 不存在"); return app; }
function toAppView(app: WidgetApp) { return WidgetAppViewSchema.parse({ ...app, allowed_origins: app.allowed_origins.split(",").map((origin) => origin.trim()).filter(Boolean) }); }
function toCreatedView(app: CreatedWidgetApp) { return CreatedWidgetAppViewSchema.parse(app); }
function parsePageValue(value: string | undefined, fallback: number, min: number, max: number): number { const parsed = value === undefined ? fallback : Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, "invalid_request", "分页参数无效"); return parsed; }
