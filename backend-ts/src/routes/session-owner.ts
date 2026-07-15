import type { FastifyRequest } from "fastify";

import type { SessionInfo } from "../contracts/session.js";
import { LOCAL_USER_ID } from "../services/identity/local-identity-provider.js";
import { HttpError } from "../utils/errors.js";

export function assertSessionOwner(request: FastifyRequest, session: SessionInfo): void {
  const identity = request.identity;
  if (session.tenant_id !== identity.tenantId) {
    throw new HttpError(404, "not_found", "会话不存在");
  }
  if (identity.userId === LOCAL_USER_ID) {
    return;
  }
  if (session.user_id !== identity.userId && !request.server.controlStore.isBotOwnedBy(session.user_id ?? "", identity.userId)) {
    throw new HttpError(403, "forbidden", "无权访问该会话");
  }
}

export function loadOwnedSession(request: FastifyRequest, sessionId: string): SessionInfo {
  const session = request.container.sessionApplication.getSession(sessionId);
  if (!session) {
    throw new HttpError(404, "not_found", "会话不存在");
  }
  assertSessionOwner(request, session);
  return session;
}

export function assertOwnedSessionIfExists(request: FastifyRequest, sessionId: string | null | undefined): void {
  if (!sessionId) {
    return;
  }
  const session = request.container.sessionApplication.getSession(sessionId);
  if (session) {
    assertSessionOwner(request, session);
  }
}

export function loadOwnedSessionForResource(
  request: FastifyRequest,
  sessionId: string | null | undefined,
  resourceNotFoundMessage: string,
): SessionInfo {
  if (!sessionId) {
    throw new HttpError(404, "not_found", resourceNotFoundMessage);
  }
  return loadOwnedSession(request, sessionId);
}
