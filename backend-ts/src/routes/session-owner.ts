import type { FastifyRequest } from "fastify";

import type { SessionInfo } from "../contracts/session.js";
import type { SaaSSessionApplication } from "../services/runtime/saas-session-application.js";
import { LOCAL_USER_ID } from "../services/identity/local-identity-provider.js";
import { HttpError } from "../utils/errors.js";

export async function assertSessionOwner(request: FastifyRequest, session: SessionInfo): Promise<void> {
  const identity = request.identity;
  if (session.tenant_id !== identity.tenantId) {
    throw new HttpError(404, "not_found", "会话不存在");
  }
  if (identity.userId === LOCAL_USER_ID) {
    return;
  }
  if (session.user_id !== identity.userId && !await request.server.botRepository.isOwnedBy(session.user_id ?? "", identity.userId)) {
    throw new HttpError(403, "forbidden", "无权访问该会话");
  }
}

export async function loadOwnedSession(
  request: FastifyRequest,
  sessionId: string,
  saas?: SaaSSessionApplication,
): Promise<SessionInfo> {
  const session = saas
    ? await saas.getSession(sessionId)
    : request.container.sessionApplication.getSession(sessionId);
  if (!session) {
    throw new HttpError(404, "not_found", "会话不存在");
  }
  await assertSessionOwner(request, session);
  return session;
}

export async function assertOwnedSessionIfExists(
  request: FastifyRequest,
  sessionId: string | null | undefined,
  saas?: SaaSSessionApplication,
): Promise<void> {
  if (!sessionId) {
    return;
  }
  const session = saas
    ? await saas.getSessionForExecutionValidation(sessionId)
    : request.container.sessionApplication.getSession(sessionId);
  if (session) {
    await assertSessionOwner(request, session);
  }
}

export async function loadOwnedSessionForResource(
  request: FastifyRequest,
  sessionId: string | null | undefined,
  resourceNotFoundMessage: string,
  saas?: SaaSSessionApplication,
): Promise<SessionInfo> {
  if (!sessionId) {
    throw new HttpError(404, "not_found", resourceNotFoundMessage);
  }
  return await loadOwnedSession(request, sessionId, saas);
}
