/**
 * Runtime Core 状态接口（/api/agent/runtime-core/status）。
 *
 * 当前只消费 readiness.llm：前端"默认"模型（selected_llm 为空）时，后端按
 * 入口 Agent tier default → 系统 LLM 兜底解析实际生效的 provider/model——
 * 思考档位选择器据此渲染默认状态下的可选档位，会话恢复据此校验
 * "默认模型 + 档位"记录，与执行路径（runtime-core-service.resolveLlm）同源。
 */

import { http } from './http.js';

// "team\u0000agent" → Promise 记忆（页面生命周期内）：选择器挂载/模型切换/团队与
// 入口 Agent 切换多处触发，解析结果在一次会话内几乎不变；agent/团队配置编辑后
// 刷新页面即更新，不做主动失效。
const defaultLlmCache = new Map();

/**
 * 解析默认生效的 LLM（入口 Agent 维度；agentName 为空时后端按团队默认入口解析）。
 * @returns {Promise<{ provider: string, provider_type: string, model: string } | null>}
 *          未配置（source=missing）/ 请求失败返回 null（不缓存，下次调用重试），调用方按"无默认模型"降级。
 */
export async function fetchDefaultLlm(teamName, agentName = '') {
  const team = (teamName || '').trim();
  const agent = (agentName || '').trim();
  const key = `${team}\u0000${agent}`;
  const cached = defaultLlmCache.get(key);
  if (cached) return cached;
  const params = new URLSearchParams();
  if (team) params.set('team_name', team);
  if (agent) params.set('agent_name', agent);
  const query = params.toString();
  const promise = http.get(`/api/agent/runtime-core/status${query ? `?${query}` : ''}`)
    .then((body) => {
      const llm = body?.data?.llm || null;
      return llm?.provider && llm?.model_name
        ? { provider: llm.provider, provider_type: llm.provider_type || '', model: llm.model_name }
        : null;
    })
    .catch(() => null);
  defaultLlmCache.set(key, promise);
  const result = await promise;
  if (!result) defaultLlmCache.delete(key);
  return result;
}
