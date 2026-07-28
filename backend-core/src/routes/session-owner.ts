import type { FastifyRequest } from "fastify";

import type { SessionInfo } from "../contracts/session/session.js";
import type { SessionApplication } from "../contracts/session/session-application.js";
import { LOCAL_USER_ID } from "../services/identity/local-identity-provider.js";
import { HttpError } from "../utils/errors.js";
import { canReadTenantSessions } from "./tenant-role.js";
import type { SessionListAccess } from "../contracts/session/session.js";

function isMatchingWidgetSession(request: FastifyRequest, session: SessionInfo): boolean {
  const { role, widgetAppKey: appKey } = request.identity;
  if (role !== "widget") return false;
  return Boolean(appKey) && session.origin_type === "widget" && session.origin_id === appKey;
}

function canAccessAsHumanPrincipal(request: FastifyRequest, session: SessionInfo): boolean {
  const identity = request.identity;
  if (session.tenant_id !== identity.tenantId) return false;
  if (identity.role === "widget") return false;
  if (identity.userId === LOCAL_USER_ID) return true;
  if (session.owner_user_id === identity.userId) return true;
  // Tenant admins intentionally retain management access to tenant-visible sessions.
  return session.visibility === "tenant" && canReadTenantSessions(identity);
}

/** Read policy for session data. Widget principals are scoped to their exact app origin. */
export function canReadSession(request: FastifyRequest, session: SessionInfo): boolean {
  if (session.tenant_id !== request.identity.tenantId) return false;
  return canAccessAsHumanPrincipal(request, session) || isMatchingWidgetSession(request, session);
}

/** Execute/respond policy. Kept separate from read so execution routes declare their capability. */
export function canExecuteSession(request: FastifyRequest, session: SessionInfo): boolean {
  if (session.tenant_id !== request.identity.tenantId) return false;
  if (session.origin_type === "widget") return isMatchingWidgetSession(request, session);
  return canAccessAsHumanPrincipal(request, session);
}

/** Mutation policy. Widget transport principals cannot edit/delete session-owned resources. */
export function canMutateSession(request: FastifyRequest, session: SessionInfo): boolean {
  return canAccessAsHumanPrincipal(request, session);
}

export function sessionListAccess(request: FastifyRequest): SessionListAccess {
  return {
    userId: request.identity.userId,
    includeTenant: request.identity.userId === LOCAL_USER_ID || canReadTenantSessions(request.identity),
  };
}

export async function assertSessionReadable(request: FastifyRequest, session: SessionInfo): Promise<void> {
  assertSessionCapability(request, session, canReadSession);
}

export async function assertSessionExecutable(request: FastifyRequest, session: SessionInfo): Promise<void> {
  assertSessionCapability(request, session, canExecuteSession);
}

export async function assertSessionMutable(request: FastifyRequest, session: SessionInfo): Promise<void> {
  assertSessionCapability(request, session, canMutateSession);
}

export async function loadReadableSession(
  request: FastifyRequest,
  sessionId: string,
  sessions?: SessionApplication,
): Promise<SessionInfo> {
  const session = await loadSession(request, sessionId, sessions);
  await assertSessionReadable(request, session);
  return session;
}

export async function loadExecutableSession(
  request: FastifyRequest,
  sessionId: string,
  sessions?: SessionApplication,
): Promise<SessionInfo> {
  const session = await loadSession(request, sessionId, sessions);
  await assertSessionExecutable(request, session);
  return session;
}

export async function loadMutableSession(
  request: FastifyRequest,
  sessionId: string,
  sessions?: SessionApplication,
): Promise<SessionInfo> {
  const session = await loadSession(request, sessionId, sessions);
  await assertSessionMutable(request, session);
  return session;
}

export async function assertReadableSessionIfExists(
  request: FastifyRequest,
  sessionId: string | null | undefined,
  sessions?: SessionApplication,
): Promise<void> {
  if (!sessionId) return;
  const session = sessions
    ? await sessions.getSessionForExecutionValidation(sessionId)
    : await request.container.sessionApplication.getSession(sessionId);
  if (session) await assertSessionReadable(request, session);
}

export async function assertExecutableSessionIfExists(
  request: FastifyRequest,
  sessionId: string | null | undefined,
  sessions?: SessionApplication,
): Promise<void> {
  if (!sessionId) return;
  const session = sessions
    ? await sessions.getSessionForExecutionValidation(sessionId)
    : await request.container.sessionApplication.getSession(sessionId);
  if (!session && request.identity.role === "widget") {
    throw new HttpError(404, "not_found", "会话不存在");
  }
  if (session) await assertSessionExecutable(request, session);
}

export async function loadReadableSessionForResource(
  request: FastifyRequest,
  sessionId: string | null | undefined,
  resourceNotFoundMessage: string,
  sessions?: SessionApplication,
): Promise<SessionInfo> {
  if (!sessionId) throw new HttpError(404, "not_found", resourceNotFoundMessage);
  return loadReadableSession(request, sessionId, sessions);
}

export async function loadMutableSessionForResource(
  request: FastifyRequest,
  sessionId: string | null | undefined,
  resourceNotFoundMessage: string,
  sessions?: SessionApplication,
): Promise<SessionInfo> {
  if (!sessionId) throw new HttpError(404, "not_found", resourceNotFoundMessage);
  return loadMutableSession(request, sessionId, sessions);
}

function assertSessionCapability(
  request: FastifyRequest,
  session: SessionInfo,
  allowed: (request: FastifyRequest, session: SessionInfo) => boolean,
): void {
  if (session.tenant_id !== request.identity.tenantId) {
    throw new HttpError(404, "not_found", "会话不存在");
  }
  if (!allowed(request, session)) {
    throw new HttpError(403, "forbidden", "无权访问该会话");
  }
}

async function loadSession(
  request: FastifyRequest,
  sessionId: string,
  sessions?: SessionApplication,
): Promise<SessionInfo> {
  const session = sessions
    ? await sessions.getSession(sessionId)
    : await request.container.sessionApplication.getSession(sessionId);
  if (!session) throw new HttpError(404, "not_found", "会话不存在");
  return session;
}
