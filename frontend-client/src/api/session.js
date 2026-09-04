import http from './http.js';

const API_BASE = '/api/agent';

/**
 * 会话请求级覆盖（模型/思考档位）即时落库：与权限模式同款"选择即更新"行为。
 * 键与后端 sendUserMessage 的发送时写入共用 `_request_overrides`（最后一次
 * 生效的值）；本函数由前端选择器变化触发，语义 = 会话当前停在选择器上的值。
 */
export async function updateSessionRequestOverrides(sessionId, overrides) {
  const result = await http.patch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/metadata`, {
    patch: {
      _request_overrides: {
        selected_llm: overrides.selectedLLM || null,
        thinking_level: overrides.thinkingLevel || null,
        updated_at: new Date().toISOString(),
      },
    },
  });
  return result?.data ?? result;
}
