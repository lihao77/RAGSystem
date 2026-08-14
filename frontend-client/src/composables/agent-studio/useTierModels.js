/**
 * LLM 层级（default/fast/powerful）与 Provider 列表的联动推导：
 * 选中 Provider 的 key 反查、模型下拉项、切换 Provider 时回填默认参数。
 * form/providers 参数可以是 ref 或普通值（toValue 归一）。
 */

import { toValue } from 'vue';

import { applyProviderToLlm, getProviderModels } from '../../utils/modelList.js';

export function useTierModels({ form, providers }) {
  function getTierProviderKey(tier) {
    const t = toValue(form)?.llm_tiers?.[tier];
    if (!t?.provider) return '';
    const matched = toValue(providers).find((p) => p.name === t.provider && (!t.provider_type || p.provider_type === t.provider_type));
    return matched ? (matched.key || matched.name) : '';
  }

  function getTierModelOptions(tier) {
    const key = getTierProviderKey(tier);
    if (!key) return [];
    const p = toValue(providers).find((item) => (item?.key || item?.name) === key);
    return getProviderModels(p);
  }

  function handleTierProviderChange(tier, key) {
    const t = toValue(form)?.llm_tiers?.[tier];
    if (!t) return;
    if (!key) { t.provider = ''; t.provider_type = ''; return; }
    const p = toValue(providers).find((item) => (item?.key || item?.name) === key);
    if (!p) return;
    Object.assign(t, applyProviderToLlm(t, p));
  }

  return { getTierProviderKey, getTierModelOptions, handleTierProviderChange };
}
