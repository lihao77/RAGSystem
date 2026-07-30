/**
 * 会话操作 API（聊天端）。
 * 收敛聊天 composables/views 原本散落的 /api/agent/sessions/* 与 /api/agent/context-snapshot 请求。
 * 仅声明端点（路径 + 方法 + 载荷），返回后端 JSON 整体；错误由 http.js 统一抛出（error.status 可用）。
 */

import { http } from './http.js';
export {
  createSession,
  getSession,
  getSessionMessages,
  getSessionPermissions,
  getSessionListFacets,
  issueSessionWsTicket,
  listSessions,
  updateSessionPermissions,
} from './session-contracts.ts';

const BASE = '/api/agent';

/** 删除会话。 */
export async function deleteSession(sessionId) {
  return http.del(`${BASE}/sessions/${encodeURIComponent(sessionId)}`);
}

/** 后端投影的唯一 Session runtime 快照。可选 signal 用于取消。 */
export async function getSessionRuntime(sessionId, { signal } = {}) {
  return http.get(`${BASE}/sessions/${encodeURIComponent(sessionId)}/runtime`, { signal });
}

/**
 * 编辑重发/原样重试：后端先回滚锚点用户消息及其后历史，再通过统一用户消息入口重新发送。
 * body: { after_seq?, after_message_id?, modify_user_message?, attachments?, ui_context?, selected_llm? }。
 * 返回 JSON 整体（data.started / data.run_id / data.task_id / data.deleted / data.error）。
 */
export async function rollbackAndRetrySession(sessionId, body) {
  return http.post(`${BASE}/sessions/${encodeURIComponent(sessionId)}/rollback-and-retry`, body);
}

/** 响应会话交互（用户输入等）。body 形如 { kind, value }。 */
export async function respondInteraction(sessionId, inputId, body) {
  return http.post(
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(inputId)}/respond`,
    body,
  );
}

/** 使用已持久化的交互结果恢复挂起 run。 */
export async function resumeSessionRun(sessionId, interactionId) {
  return http.post(
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/resume`,
    {},
  );
}

/** 上下文快照（token_stats 等）。selectedLlm 可选。 */
export async function getContextSnapshot(sessionId, { selectedLlm } = {}) {
  const params = new URLSearchParams();
  if (sessionId) params.set('session_id', sessionId);
  if (selectedLlm) params.set('selected_llm', selectedLlm);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return http.get(`${BASE}/context-snapshot${suffix}`);
}

/**
 * 导出会话（blob 下载）。返回 { blob, headers }，调用方解析 content-disposition 得到 filename 并触发下载。
 * 走 http.getRaw 以拿到原始响应（默认响应拦截器只返回 JSON body，会丢 blob 与 headers）。
 */
export async function exportSession(sessionId) {
  const resp = await http.getRaw(`${BASE}/sessions/${encodeURIComponent(sessionId)}/export`, {
    responseType: 'blob',
  });
  return { blob: resp.data, headers: resp.headers };
}

/**
 * 启动执行流（POST /api/agent/stream）。requestId 作为 x-request-id 头。
 * 返回 JSON 整体（data.started / data.run_id / data.error / data.kind）。
 */
export async function startStream(body, requestId) {
  return http.post(`${BASE}/stream`, body, { headers: { 'x-request-id': requestId } });
}

/** 停止执行流（WS 不可用时的 HTTP 降级）。 */
export async function stopStream(sessionId) {
  return http.post(`${BASE}/stream/stop`, { session_id: sessionId });
}
