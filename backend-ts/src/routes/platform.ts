import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { createTenantId, createUserId, type TenantId } from "../identity/types.js";
import type {
  ControlStore,
  PlatformRole,
  TenantStatus,
  UserStatus,
} from "../services/stores/control-store/index.js";
import type { TenantRuntimeRegistry } from "../services/runtime/tenant-runtime-registry.js";
import { HttpError } from "../utils/errors.js";
import { requirePlatformAdmin } from "./platform-guard.js";

interface PlatformRouteOptions {
  controlStore: ControlStore;
  registry: TenantRuntimeRegistry;
}

interface TenantParams {
  tenantId: string;
}

interface UserParams {
  userId: string;
}

interface SessionParams {
  sessionId: string;
}

const TenantStatusSchema = z.enum(["active", "suspended"]);
const UserStatusSchema = z.enum(["active", "disabled"]);
const PlatformRoleSchema = z.enum(["admin"]).nullable();

export const registerPlatformRoutes: FastifyPluginAsync<PlatformRouteOptions> = async (app, options) => {
  app.get("/tenants", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const query = request.query as Record<string, string | undefined>;
    const limit = parseIntQuery(query.limit);
    const offset = parseIntQuery(query.offset);
    const result = options.controlStore.listAllTenants({
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(query.status ? { status: TenantStatusSchema.parse(query.status) } : {}),
      ...(query.query ? { query: query.query } : {}),
    });
    options.controlStore.recordPlatformAudit({ actorUserId: actor.id, action: "list_tenants", targetResource: "tenants" });
    return { success: true, tenants: result.items, ...result };
  });

  app.patch<{ Params: TenantParams }>("/tenants/:tenantId/status", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const tenantId = createTenantId(request.params.tenantId);
    const input = z.object({ status: TenantStatusSchema }).parse(request.body);
    if (!options.controlStore.setTenantStatus(tenantId, input.status)) {
      throw new HttpError(404, "not_found", "租户不存在");
    }
    options.controlStore.recordPlatformAudit({
      actorUserId: actor.id,
      action: "set_tenant_status",
      targetTenantId: tenantId,
      targetResource: `tenant:${tenantId}`,
      detail: { status: input.status },
    });
    return { success: true, tenant: options.controlStore.getTenant(tenantId) };
  });

  app.get("/users", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const query = request.query as Record<string, string | undefined>;
    const limit = parseIntQuery(query.limit);
    const offset = parseIntQuery(query.offset);
    const result = options.controlStore.listAllUsers({
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(query.status ? { status: UserStatusSchema.parse(query.status) } : {}),
      ...(query.platformRole !== undefined ? { platformRole: parsePlatformRoleFilter(query.platformRole) } : {}),
      ...(query.query ? { query: query.query } : {}),
    });
    options.controlStore.recordPlatformAudit({ actorUserId: actor.id, action: "list_users", targetResource: "users" });
    return { success: true, users: result.items, ...result };
  });

  app.get("/bots", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const bots = options.controlStore.listAllBots();
    options.controlStore.recordPlatformAudit({ actorUserId: actor.id, action: "list_bots", targetResource: "bots" });
    return { success: true, bots };
  });

  app.patch<{ Params: UserParams }>("/users/:userId/status", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const userId = createUserId(request.params.userId);
    const input = z.object({ status: UserStatusSchema }).parse(request.body);
    if (!options.controlStore.setUserStatus(userId, input.status)) {
      throw new HttpError(404, "not_found", "用户不存在");
    }
    if (options.controlStore.getBot(userId)) app.botEngine.reloadBot(userId);
    options.controlStore.recordPlatformAudit({
      actorUserId: actor.id,
      action: "set_user_status",
      targetResource: `user:${userId}`,
      detail: { status: input.status },
    });
    return { success: true, user: options.controlStore.getUser(userId) };
  });

  app.patch<{ Params: UserParams }>("/users/:userId/platform-role", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const userId = createUserId(request.params.userId);
    const input = z.object({ platformRole: PlatformRoleSchema }).parse(request.body);
    if (!options.controlStore.setUserPlatformRole(userId, input.platformRole)) {
      throw new HttpError(404, "not_found", "用户不存在");
    }
    options.controlStore.recordPlatformAudit({
      actorUserId: actor.id,
      action: "set_user_platform_role",
      targetResource: `user:${userId}`,
      detail: { platformRole: input.platformRole },
    });
    return { success: true, user: options.controlStore.getUser(userId) };
  });

  app.get<{ Params: TenantParams }>("/tenants/:tenantId/sessions", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const tenantId = requireExistingTenant(options.controlStore, request.params.tenantId);
    const query = request.query as Record<string, string | undefined>;
    return withTenantRuntime(options.registry, tenantId, (runtime) => {
      const sessions = runtime.sessionApplication.listSessions({
        tenantId,
        limit: parseIntQuery(query.limit) ?? 20,
        offset: parseIntQuery(query.offset) ?? 0,
      });
      options.controlStore.recordPlatformAudit({ actorUserId: actor.id, action: "read_tenant_sessions", targetTenantId: tenantId, targetResource: `tenant:${tenantId}:sessions` });
      return { success: true, data: redactSensitive(sessions) };
    });
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const tenantId = requireQueryTenant(options.controlStore, request.query);
    return withTenantRuntime(options.registry, tenantId, (runtime) => {
      const session = runtime.sessionApplication.getSession(request.params.sessionId);
      if (!session) throw new HttpError(404, "not_found", "会话不存在");
      options.controlStore.recordPlatformAudit({ actorUserId: actor.id, action: "read_session", targetTenantId: tenantId, targetResource: `session:${request.params.sessionId}` });
      return { success: true, data: redactSensitive(session) };
    });
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/messages", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const tenantId = requireQueryTenant(options.controlStore, request.query);
    const query = request.query as Record<string, string | undefined>;
    return withTenantRuntime(options.registry, tenantId, (runtime) => {
      if (!runtime.sessionApplication.getSession(request.params.sessionId)) {
        throw new HttpError(404, "not_found", "会话不存在");
      }
      const messages = runtime.sessionApplication.listMessages({
        sessionId: request.params.sessionId,
        limit: parseIntQuery(query.limit) ?? 20,
        offset: parseIntQuery(query.offset) ?? 0,
      });
      options.controlStore.recordPlatformAudit({ actorUserId: actor.id, action: "read_session_messages", targetTenantId: tenantId, targetResource: `session:${request.params.sessionId}:messages` });
      return { success: true, data: redactSensitive(messages) };
    });
  });

  app.get<{ Params: TenantParams }>("/tenants/:tenantId/health", async (request) => {
    const actor = requirePlatformAdmin(request, options.controlStore);
    const tenantId = requireExistingTenant(options.controlStore, request.params.tenantId);
    return withTenantRuntime(options.registry, tenantId, (runtime) => {
      const sessionsCount = runtime.sessionApplication.listSessions({ tenantId, limit: 1, offset: 0 }).total;
      options.controlStore.recordPlatformAudit({ actorUserId: actor.id, action: "read_tenant_health", targetTenantId: tenantId, targetResource: `tenant:${tenantId}:health` });
      return { success: true, data: { status: "healthy", tenantId, sessionsCount } };
    });
  });
};

function parseIntQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new HttpError(400, "invalid_request", "分页参数无效");
  return parsed;
}

function parsePlatformRoleFilter(value: string): PlatformRole | null {
  if (value === "none" || value === "null" || value === "") return null;
  return z.enum(["admin"]).parse(value);
}

function requireExistingTenant(controlStore: ControlStore, rawTenantId: string): TenantId {
  const tenantId = createTenantId(rawTenantId);
  if (!controlStore.getTenant(tenantId)) throw new HttpError(404, "not_found", "租户不存在");
  return tenantId;
}

function requireQueryTenant(controlStore: ControlStore, rawQuery: unknown): TenantId {
  const query = rawQuery as { tenantId?: string };
  if (!query.tenantId) throw new HttpError(400, "invalid_request", "tenantId 查询参数必填");
  return requireExistingTenant(controlStore, query.tenantId);
}

async function withTenantRuntime<T>(registry: TenantRuntimeRegistry, tenantId: TenantId, operation: (runtime: Awaited<ReturnType<TenantRuntimeRegistry["acquire"]>>["runtime"]) => T | Promise<T>): Promise<T> {
  const lease = await registry.acquire(tenantId);
  try {
    return await operation(lease.runtime);
  } finally {
    lease.release();
  }
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /password_hash|passwordHash|token|secret/i.test(key) ? "[REDACTED]" : redactSensitive(entry),
  ]));
}
