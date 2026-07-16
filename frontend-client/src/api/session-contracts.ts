import type {
  CreateSessionRequest,
  SessionWsTicketResponse,
  UpdateSessionPermissionModeRequest,
} from '@ragsystem/api-contracts';

import { http } from './http.js';

const BASE = '/api/agent';

export function createSession(body: CreateSessionRequest): Promise<unknown> {
  return http.post(`${BASE}/sessions`, body);
}

export function issueSessionWsTicket(sessionId: string): Promise<SessionWsTicketResponse> {
  return http.post(`${BASE}/sessions/${encodeURIComponent(sessionId)}/ws-ticket`);
}

export function updateSessionPermissions(
  sessionId: string,
  mode: UpdateSessionPermissionModeRequest['mode'],
): Promise<unknown> {
  return http.patch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/permissions`, { mode });
}
