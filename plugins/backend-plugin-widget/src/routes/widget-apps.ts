import type { FastifyPluginAsync } from "fastify";

import { CreatedWidgetAppViewSchema, CreateWidgetAppRequestSchema, UpdateWidgetAppRequestSchema, WidgetAppViewSchema, WidgetAuditViewSchema, WidgetTokenViewSchema } from "../contracts/widget.js";
import type { CreatedWidgetAppCredential, WidgetAppCredential, WidgetCredentialRepository } from "../contracts/widget-credentials.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { requireTenantAdmin, requireTenantOwner } from "@ragsystem/backend-core/routes/tenant-role.js";

interface AppParams { key: string; }
interface TokenParams extends AppParams { jti: string; }
interface AuditQuery { limit?: string; offset?: string; }

export interface WidgetAppsRouteOptions {
  credentials: WidgetCredentialRepository;
  enabled: boolean;
}

export const registerWidgetAppsRoutes: FastifyPluginAsync<WidgetAppsRouteOptions> = async (app, options) => {
  const store = options.credentials;
  if (!options.enabled) {
    const disabled = async () => { throw new HttpError(503, "widget_disabled", "未配置 WIDGET_JWT_KEY_RING，widget 接入未启用"); };
    app.all("/", disabled);
    app.all("/*", disabled);
    return;
  }

  app.addHook("preHandler", async (request) => { requireTenantAdmin(request); });

  app.get("/", async (request) => {
    const { tenantId } = request.identity;
    return { success: true, apps: (await store.apps.list(tenantId)).map(toAppView) };
  });
  app.post("/", async (request) => {
    requireTenantOwner(request);
    const { tenantId } = request.identity;
    const body = CreateWidgetAppRequestSchema.parse(request.body);
    const created = await store.apps.create({ tenantId, ...body });
    await store.audit.record(tenantId, { app_key: created.app_key, action: "create", actor: "console", detail: { display_name: created.display_name, allowed_origins: created.allowed_origins } });
    return { success: true, app: toCreatedView(created) };
  });
  app.get<{ Params: AppParams }>("/:key", async (request) => {
    const { tenantId } = request.identity;
    return { success: true, app: toAppView(requireApp(await store.apps.get(tenantId, request.params.key))) };
  });
  app.patch<{ Params: AppParams }>("/:key", async (request) => {
    const { tenantId } = request.identity;
    const body = UpdateWidgetAppRequestSchema.parse(request.body);
    const update = {
      ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
      ...(body.allowed_origins !== undefined ? { allowed_origins: body.allowed_origins } : {}),
    };
    const updated = await store.apps.update(tenantId, request.params.key, update);
    if (!updated) throw new HttpError(404, "not_found", "widget app 不存在");
    await store.audit.record(tenantId, { app_key: updated.app_key, action: "update", actor: "console", detail: body });
    return { success: true, app: toAppView(updated) };
  });
  app.post<{ Params: AppParams }>("/:key/rotate-secret", async (request) => {
    requireTenantOwner(request);
    const { tenantId } = request.identity;
    const rotated = await store.apps.rotateSecret(tenantId, request.params.key);
    if (!rotated) throw new HttpError(404, "not_found", "widget app 不存在或已吊销");
    await store.audit.record(tenantId, { app_key: rotated.app_key, action: "rotate_secret", actor: "console" });
    return { success: true, app: toCreatedView(rotated) };
  });
  app.post<{ Params: AppParams }>("/:key/revoke", async (request) => {
    const { tenantId } = request.identity;
    if (!await store.apps.revoke(tenantId, request.params.key)) throw new HttpError(404, "not_found", "widget app 不存在或已吊销");
    await store.audit.record(tenantId, { app_key: request.params.key, action: "revoke", actor: "console" });
    return { success: true, app: toAppView(requireApp(await store.apps.get(tenantId, request.params.key))) };
  });
  app.get<{ Params: AppParams }>("/:key/tokens", async (request) => {
    const { tenantId } = request.identity;
    return { success: true, tokens: (await store.tokens.listByApp(tenantId, request.params.key)).map((token) => WidgetTokenViewSchema.parse(token)) };
  });
  app.delete<{ Params: TokenParams }>("/:key/tokens/:jti", async (request) => {
    const { tenantId } = request.identity;
    requireApp(await store.apps.get(tenantId, request.params.key));
    if (!(await store.tokens.listByApp(tenantId, request.params.key)).some((token) => token.jti === request.params.jti)) throw new HttpError(404, "not_found", "widget token 不存在");
    await store.tokens.revoke(tenantId, request.params.jti);
    await store.audit.record(tenantId, { app_key: request.params.key, action: "revoke_token", actor: "console", detail: { jti: request.params.jti } });
    return { success: true };
  });
  app.get<{ Params: AppParams; Querystring: AuditQuery }>("/:key/audit", async (request) => {
    const { tenantId } = request.identity;
    requireApp(await store.apps.get(tenantId, request.params.key));
    const limit = parsePageValue(request.query.limit, 100, 1, 500);
    const offset = parsePageValue(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return { success: true, audit: (await store.audit.list(tenantId, request.params.key, limit, offset)).map((entry) => WidgetAuditViewSchema.parse(entry)) };
  });
};

function requireApp(app: WidgetAppCredential | null): WidgetAppCredential { if (!app) throw new HttpError(404, "not_found", "widget app 不存在"); return app; }
function toAppView(app: WidgetAppCredential) { return WidgetAppViewSchema.parse({ ...app, allowed_origins: app.allowed_origins.split(",").map((origin) => origin.trim()).filter(Boolean) }); }
function toCreatedView(app: CreatedWidgetAppCredential) { return CreatedWidgetAppViewSchema.parse(app); }
function parsePageValue(value: string | undefined, fallback: number, min: number, max: number): number { const parsed = value === undefined ? fallback : Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, "invalid_request", "分页参数无效"); return parsed; }
