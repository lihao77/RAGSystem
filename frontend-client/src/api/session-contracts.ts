import type {
  CreateSessionRequest,
  CreateSessionResponse,
  SessionDetailResponse,
  SessionListFacetsResponse,
  SessionListResponse,
  SessionMessageListResponse,
  SessionMessageRunStepsData,
  SessionMessageRunStepsResponse,
  SessionPermissionResponse,
  SessionWsTicketResponse,
  UpdateSessionPermissionModeRequest,
  SessionOriginType,
} from '@ragsystem/api-contracts';

import { http } from './http.js';

const BASE = '/api/agent';

export interface ListSessionsQuery {
  limit?: number;
  cursor?: string | null;
  originType?: SessionOriginType | null;
  originId?: string | null;
  workspaceId?: string | null;
  signal?: AbortSignal;
}

export interface PaginationQuery {
  limit?: number;
  offset?: number;
}

export function createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
  return http.post(`${BASE}/sessions`, body);
}

export function listSessions({
  limit = 20,
  cursor = null,
  originType = null,
  originId = null,
  workspaceId = null,
  signal,
}: ListSessionsQuery = {}): Promise<SessionListResponse> {
  return http.get(`${BASE}/sessions`, {
    params: {
      limit,
      ...(cursor ? { cursor } : {}),
      ...(originType ? { origin_type: originType } : {}),
      ...(originId ? { origin_id: originId } : {}),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    },
    signal,
  });
}

export function getSessionListFacets({ signal }: { signal?: AbortSignal } = {}): Promise<SessionListFacetsResponse> {
  return http.get(`${BASE}/sessions/facets`, { signal });
}

export function getSession(sessionId: string): Promise<SessionDetailResponse> {
  return http.get(`${BASE}/sessions/${encodeURIComponent(sessionId)}`);
}

export function issueSessionWsTicket(sessionId: string): Promise<SessionWsTicketResponse> {
  return http.post(`${BASE}/sessions/${encodeURIComponent(sessionId)}/ws-ticket`);
}

export function getSessionPermissions(sessionId: string): Promise<SessionPermissionResponse> {
  return http.get(`${BASE}/sessions/${encodeURIComponent(sessionId)}/permissions`);
}

export function getSessionMessages(
  sessionId: string,
  { limit = 500, offset = 0 }: PaginationQuery = {},
): Promise<SessionMessageListResponse> {
  return http.get(`${BASE}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    params: { limit, offset },
  });
}

export async function getMessageRunSteps(
  sessionId: string,
  messageId: string,
  { limit = 500, offset = 0 }: PaginationQuery = {},
): Promise<SessionMessageRunStepsData> {
  const result = await http.get(`${BASE}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/run-steps`, {
    params: { limit, offset },
  }) as SessionMessageRunStepsResponse;
  return result.data;
}

export function updateSessionPermissions(
  sessionId: string,
  mode: UpdateSessionPermissionModeRequest['mode'],
): Promise<SessionPermissionResponse> {
  return http.patch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/permissions`, { mode });
}
