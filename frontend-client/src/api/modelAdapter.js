/**
 * Model Adapter API 调用模块。
 */

import { http } from './http.js'
import { thinkingCapabilityFor } from '../utils/thinkingLevels.js'
import { normalizeProviderTestResult } from '../utils/providerTestResult.js'

const API_BASE = '/api/model-adapter'

export async function getApiFormats() {
  const data = await http.get(`${API_BASE}/api-formats`)
  return data.data || []
}

/**
 * Models.dev 目录厂商摘要（后端缓存代理；拉不到时 available:false，前端隐藏目录填充区）。
 */
export async function getCatalogProviders() {
  const data = await http.get(`${API_BASE}/catalog/providers`)
  return data.data || { available: false, stale: false, providers: [] }
}

/** 目录单厂商模型列表（自动填充用）。 */
export async function getCatalogProviderModels(catalogId) {
  const data = await http.get(`${API_BASE}/catalog/providers/${encodeURIComponent(catalogId)}/models`)
  return data.data || null
}

export async function getProviders() {
  try {
    const data = await http.get(`${API_BASE}/providers`)
    return data.providers || data.data || []
  } catch (error) {
    console.error('Error fetching providers:', error)
    throw error
  }
}

function collectProviderModels(provider) {
  const result = []
  const seen = new Set()
  if (!Array.isArray(provider.models)) return result
  for (const entry of provider.models) {
    const model = String(entry?.name || '').trim()
    if (!model || seen.has(model)) continue
    result.push({ model })
    seen.add(model)
  }
  return result
}

export async function getAvailableModels() {
  try {
    const providers = await getProviders()
    const models = []
    const seen = new Set()

    providers.forEach(provider => {
      const name = provider.name || provider.key || ''
      const ptype = provider.provider_type || ''
      const displayName = name + (ptype ? ` (${ptype})` : '')

      collectProviderModels(provider).forEach(({ model }) => {
        const value = `${name}|${ptype}|${model}`
        if (seen.has(value)) return
        seen.add(value)
        models.push({
          label: `${displayName} / ${model}`,
          value,
          provider: name,
          provider_type: ptype,
          model
        })
      })
    })

    return models
  } catch (error) {
    console.error('Error getting available models:', error)
    return []
  }
}

export function findProviderModelByValue(value) {
  const [provider = '', provider_type = '', model = ''] = String(value || '').split('|')
  return { provider, provider_type, model }
}

/**
 * 取指定模型（"provider|type|model" 值）的思考能力 descriptor（格式档位 × 模型级子集）。
 * 后端在 /providers 响应里注入 thinking 字段（agent-llm 注册表 + thinking_kind 覆盖）；
 * 模型条目带 thinking_levels 子集时（目录 effort 值域）强度档位以子集为准。
 * 旧后端/无值 → kind 'none'（调用方应隐藏选择器）。
 */
export async function describeThinkingForModel(selectedValue) {
  const { provider: providerName, model } = findProviderModelByValue(selectedValue)
  if (!providerName) return { kind: 'none', levels: [] }
  try {
    const providers = await getProviders()
    const provider = providers.find(item => (item.name || item.key) === providerName)
    return thinkingCapabilityFor(provider, model)
  } catch {
    return { kind: 'none', levels: [] }
  }
}

/**
 * 会话 metadata._request_overrides → 可安全回显的覆盖值（恢复对话用）。纯函数：
 * providers 由调用方注入（聊天页走 dictionaries 的 ensureProviders 缓存）。
 * 返回 null = 无记录（存量会话/新会话），调用方不应建覆盖层，保持全局个人默认。
 * 有记录时逐项校验：selected_llm 需仍存在于 providers（模型名非空才匹配，
 * 防 "provider|" 两段值误命中无名条目）；thinking_level 需在该模型合法档位内
 * （且依赖模型命中）。校验失败该项回退空串（= 会话内显示"默认/跟随"）——
 * 宁可不恢复也不回显一个后端会拒收的值。
 */
export function resolveRestorableOverrides(metadata, providers) {
  const record = metadata && typeof metadata === 'object' ? metadata._request_overrides : null
  if (!record || typeof record !== 'object') return null
  const list = Array.isArray(providers) ? providers : []
  const result = { selectedLLM: '', thinkingLevel: '' }
  const rawLlm = typeof record.selected_llm === 'string' ? record.selected_llm.trim() : ''
  if (rawLlm) {
    const { provider: providerName, model: modelName } = findProviderModelByValue(rawLlm)
    const provider = providerName && modelName
      ? list.find(item => (item.name || item.key) === providerName)
      : null
    const modelEntry = provider && Array.isArray(provider.models)
      ? provider.models.find(item => String(item?.name || '') === modelName)
      : null
    if (provider && modelEntry) {
      result.selectedLLM = rawLlm
      const rawLevel = typeof record.thinking_level === 'string' ? record.thinking_level.trim() : ''
      if (rawLevel) {
        const capability = thinkingCapabilityFor(provider, modelName)
        if (capability.levels.includes(rawLevel)) result.thinkingLevel = rawLevel
      }
    }
  }
  return result
}

export async function createProvider(data) {
  return http.post(`${API_BASE}/providers`, data)
}

export async function updateProvider(providerKey, data) {
  return http.put(`${API_BASE}/providers/${encodeURIComponent(providerKey)}`, data)
}

export async function reorderProviders(providerKeys) {
  return http.put(`${API_BASE}/providers/order`, { provider_keys: providerKeys })
}

export async function deleteProvider(providerKey) {
  return http.del(`${API_BASE}/providers/${encodeURIComponent(providerKey)}`)
}

export async function getProviderUsages(providerKey) {
  const data = await http.get(`${API_BASE}/providers/${encodeURIComponent(providerKey)}/usages`)
  return data.data?.usages || data.usages || []
}

export async function checkProviderAvailability(providerKey) {
  const data = await http.get(`${API_BASE}/providers/${encodeURIComponent(providerKey)}/check`)
  return data.data || data
}

export async function testProvider(provider, model, prompt = 'Hello', providerType = '', task = 'chat', documents = undefined) {
  try {
    const data = await http.post(`${API_BASE}/test`, {
      provider,
      provider_type: providerType,
      model: String(model || '').trim(),
      prompt,
      task,
      ...(documents ? { documents } : {})
    })

    return normalizeProviderTestResult(data)
  } catch (error) {
    console.error('Error testing provider:', error)
    throw error
  }
}
