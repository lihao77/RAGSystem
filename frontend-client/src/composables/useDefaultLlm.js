import { onScopeDispose, ref, toValue, watch } from 'vue';
import { defaultLlmRevision, fetchDefaultLlm } from '../api/runtimeCore.js';

/** 默认模型展示与思考能力共用同一解析，切换上下文时忽略过期响应。 */
export function useDefaultLlm(team, agent) {
  const llm = ref(null);
  const loading = ref(false);
  let sequence = 0;

  const refresh = async () => {
    const current = ++sequence;
    loading.value = true;
    const result = await fetchDefaultLlm(toValue(team), toValue(agent));
    if (current !== sequence) return;
    llm.value = result;
    loading.value = false;
  };

  watch([() => toValue(team), () => toValue(agent), defaultLlmRevision], () => {
    llm.value = null;
    refresh();
  }, { immediate: true });
  onScopeDispose(() => { sequence += 1; });

  return { llm, loading, refresh };
}
