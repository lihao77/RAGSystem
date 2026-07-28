import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { createTenantId, createUserId, type TenantId } from "../identity/types.js";
import type {
  ControlPlane,
  PlatformRole,
  TenantStatus,
  UserStatus,
} from "../contracts/control-plane/index.js";
import type { RuntimeContainerRegistry as TenantRuntimeRegistry } from "../services/runtime/runtime-container-registry.js";
import { HttpError } from "../utils/errors.js";
import { requirePlatformAdmin } from "./platform-guard.js";
import { decodeSessionListCursor, encodeSessionListCursor } from "./session-list-cursor.js";

interface PlatformRouteOptions {
  controlPlane: ControlPlane;
  registry: TenantRuntimeRegistry;
  emitPluginEvent?: (event: string, payload: unknown) => Promise<void>;
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
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const query = request.query as Record<string, string | undefined>;
    const limit = parseIntQuery(query.limit);
    const offset = parseIntQuery(query.offset);
    const result = await options.controlPlane.tenants.listPage({
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(query.status ? { status: TenantStatusSchema.parse(query.status) } : {}),
      ...(query.query ? { query: query.query } : {}),
    });
    await options.controlPlane.audit.record({ actorUserId: actor.id, action: "list_tenants", targetResource: "tenants" });
    return { success: true, tenants: result.items, ...result };
  });

  app.patch<{ Params: TenantParams }>("/tenants/:tenantId/status", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const tenantId = createTenantId(request.params.tenantId);
    const input = z.object({ status: TenantStatusSchema }).parse(request.body);
    const tenant = await options.controlPlane.commands.setTenantStatus({
      actorUserId: actor.id,
      tenantId,
      status: input.status,
    });
    if (!tenant) {
      throw new HttpError(404, "not_found", "租户不存在");
    }
    return { success: true, tenant };
  });

  app.get("/users", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const query = request.query as Record<string, string | undefined>;
    const limit = parseIntQuery(query.limit);
    const offset = parseIntQuery(query.offset);
    const result = await options.controlPlane.users.listPage({
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(query.status ? { status: UserStatusSchema.parse(query.status) } : {}),
      ...(query.platformRole !== undefined ? { platformRole: parsePlatformRoleFilter(query.platformRole) } : {}),
      ...(query.query ? { query: query.query } : {}),
    });
    await options.controlPlane.audit.record({ actorUserId: actor.id, action: "list_users", targetResource: "users" });
    return { success: true, users: result.items, ...result };
  });

  app.patch<{ Params: UserParams }>("/users/:userId/status", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const userId = createUserId(request.params.userId);
    const input = z.object({ status: UserStatusSchema }).parse(request.body);
    const user = await options.controlPlane.commands.setUserStatus({
      actorUserId: actor.id,
      userId,
      status: input.status,
    });
    if (!user) {
      throw new HttpError(404, "not_found", "用户不存在");
    }
    await options.emitPluginEvent?.("resource.changed", {
      resourceType: "user",
      resourceId: userId,
      change: "status",
    });
    return { success: true, user };
  });

  app.patch<{ Params: UserParams }>("/users/:userId/platform-role", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const userId = createUserId(request.params.userId);
    const input = z.object({ platformRole: PlatformRoleSchema }).parse(request.body);
    const user = await options.controlPlane.commands.setUserPlatformRole({
      actorUserId: actor.id,
      userId,
      platformRole: input.platformRole,
    });
    if (!user) {
      throw new HttpError(404, "not_found", "用户不存在");
    }
    return { success: true, user };
  });

  app.get<{ Params: TenantParams }>("/tenants/:tenantId/sessions", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const tenantId = await requireExistingTenant(options.controlPlane, request.params.tenantId);
    const query = request.query as Record<string, string | undefined>;
    return withTenantRuntime(options.registry, tenantId, async (runtime) => {
      const sessions = await runtime.sessionApplication.listSessions({
        limit: parseIntQuery(query.limit) ?? 20,
        cursor: decodeSessionListCursor(query.cursor),
        access: { userId: actor.id, includeTenant: true, includeAll: true },
      });
      await options.controlPlane.audit.record({ actorUserId: actor.id, action: "read_tenant_sessions", targetTenantId: tenantId, targetResource: `tenant:${tenantId}:sessions` });
      return { success: true, data: redactSensitive({ items: sessions.items, next_cursor: sessions.nextCursor ? encodeSessionListCursor(sessions.nextCursor) : null }) };
    });
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const tenantId = await requireQueryTenant(options.controlPlane, request.query);
    return withTenantRuntime(options.registry, tenantId, async (runtime) => {
      const session = await runtime.sessionApplication.getSession(request.params.sessionId);
      if (!session) throw new HttpError(404, "not_found", "会话不存在");
      await options.controlPlane.audit.record({ actorUserId: actor.id, action: "read_session", targetTenantId: tenantId, targetResource: `session:${request.params.sessionId}` });
      return { success: true, data: redactSensitive(session) };
    });
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/messages", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const tenantId = await requireQueryTenant(options.controlPlane, request.query);
    const query = request.query as Record<string, string | undefined>;
    return withTenantRuntime(options.registry, tenantId, async (runtime) => {
      if (!await runtime.sessionApplication.getSession(request.params.sessionId)) {
        throw new HttpError(404, "not_found", "会话不存在");
      }
      const messages = await runtime.sessionApplication.listMessages({
        sessionId: request.params.sessionId,
        limit: parseIntQuery(query.limit) ?? 20,
        offset: parseIntQuery(query.offset) ?? 0,
      });
      await options.controlPlane.audit.record({ actorUserId: actor.id, action: "read_session_messages", targetTenantId: tenantId, targetResource: `session:${request.params.sessionId}:messages` });
      return { success: true, data: redactSensitive(messages) };
    });
  });

  app.get<{ Params: TenantParams }>("/tenants/:tenantId/health", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const tenantId = await requireExistingTenant(options.controlPlane, request.params.tenantId);
    return withTenantRuntime(options.registry, tenantId, async (runtime) => {
      const counts = await runtime.sessionApplication.listSessionFacets({ access: { userId: actor.id, includeTenant: true, includeAll: true } });
      const sessionsCount = counts.typeCounts.direct + counts.typeCounts.bot + counts.typeCounts.widget;
      await options.controlPlane.audit.record({ actorUserId: actor.id, action: "read_tenant_health", targetTenantId: tenantId, targetResource: `tenant:${tenantId}:health` });
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

async function requireExistingTenant(controlPlane: ControlPlane, rawTenantId: string): Promise<TenantId> {
  const tenantId = createTenantId(rawTenantId);
  if (!await controlPlane.tenants.get(tenantId)) throw new HttpError(404, "not_found", "租户不存在");
  return tenantId;
}

async function requireQueryTenant(controlPlane: ControlPlane, rawQuery: unknown): Promise<TenantId> {
  const query = rawQuery as { tenantId?: string };
  if (!query.tenantId) throw new HttpError(400, "invalid_request", "tenantId 查询参数必填");
  return await requireExistingTenant(controlPlane, query.tenantId);
}

async function withTenantRuntime<T>(registry: TenantRuntimeRegistry, tenantId: TenantId, operation: (runtime: Awaited<ReturnType<TenantRuntimeRegistry["acquire"]>>["runtime"]) => T | Promise<T>): Promise<T> {
  const lease = await registry.acquireForInspection(tenantId);
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
