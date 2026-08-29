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
