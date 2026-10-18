/**
 * Runtime Core 状态接口（/api/agent/runtime-core/status）。
 *
 * 当前只消费 readiness.llm：前端"默认"模型（selected_llm 为空）时，后端按
 * 入口 Agent tier default → 系统 LLM 兜底解析实际生效的 provider/model——
 * 思考档位选择器据此渲染默认状态下的可选档位，会话恢复据此校验
 * "默认模型 + 档位"记录，与执行路径（runtime-core-service.resolveLlm）同源。
 */

import { readonly, ref } from 'vue';
import { http } from './http.js';

// 合并并发请求；配置保存主动失效，短 TTL 同时覆盖其他窗口/外部配置编辑。
const defaultLlmCache = new Map();
const cacheRevision = ref(0);
const CACHE_TTL_MS = 30_000;
export const defaultLlmRevision = readonly(cacheRevision);

export function invalidateDefaultLlm() {
  defaultLlmCache.clear();
  cacheRevision.value += 1;
}

/**
 * 解析默认生效的 LLM（入口 Agent 维度；agentName 为空时后端按团队默认入口解析）。
 * @returns {Promise<{ provider: string, provider_type: string, model: string, source: string, fallback_reason: string | null } | null>}
 *          未配置（source=missing）/ 请求失败返回 null（不缓存，下次调用重试），调用方按"无默认模型"降级。
 */
export async function fetchDefaultLlm(teamName, agentName = '') {
  const team = (teamName || '').trim();
  const agent = (agentName || '').trim();
  const key = `${team}\u0000${agent}`;
  const cached = defaultLlmCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const revision = cacheRevision.value;
  const params = new URLSearchParams();
  if (team) params.set('team_name', team);
  if (agent) params.set('agent_name', agent);
  const query = params.toString();
  const promise = http.get(`/api/agent/runtime-core/status${query ? `?${query}` : ''}`)
    .then((body) => {
      const llm = body?.data?.llm || null;
      return llm?.source !== 'missing' && llm?.provider && llm?.model_name
        ? { provider: llm.provider, provider_type: llm.provider_type || '', model: llm.model_name,
          source: llm.source || '', fallback_reason: llm.fallback_reason || null }
        : null;
    })
    .catch(() => null);
  const entry = { promise: null, expiresAt: Infinity };
  entry.promise = promise.then((result) => {
    // 失效前发出的请求不能作为新配置的解析结果，也不能清掉新请求的缓存。
    if (revision !== cacheRevision.value) return fetchDefaultLlm(team, agent);
    if (defaultLlmCache.get(key) === entry) {
      if (!result) defaultLlmCache.delete(key);
      else entry.expiresAt = Date.now() + CACHE_TTL_MS;
    }
    return result;
  });
  defaultLlmCache.set(key, entry);
  // 限制长期打开页面时访问过的 team/agent 组合数量。
  if (defaultLlmCache.size > 100) defaultLlmCache.delete(defaultLlmCache.keys().next().value);
  return entry.promise;
}
