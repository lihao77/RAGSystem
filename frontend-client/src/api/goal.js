/**
 * Session-scoped Goal API.
 *
 * Goal is the durable workflow state for a chat session. The response body is
 * returned unchanged so callers can use the backend contract directly.
 */

import { http } from './http.js';

const BASE = '/api/agent/sessions';

function goalBase(sessionId) {
  return `${BASE}/${encodeURIComponent(sessionId)}/goals`;
}

/** Read the current Goal for a session. */
export async function getCurrentGoal(sessionId, { signal } = {}) {
  return http.get(`${goalBase(sessionId)}/current`, { signal });
}

/** List all Goals that belong to a session. */
export async function listGoals(sessionId, { signal } = {}) {
  return http.get(goalBase(sessionId), { signal });
}

/** Start or resume the current Goal. */
export async function startCurrentGoal(sessionId) {
  return http.post(`${goalBase(sessionId)}/current/start`);
}

/** Pause the current Goal. */
export async function pauseCurrentGoal(sessionId) {
  return http.post(`${goalBase(sessionId)}/current/pause`);
}

