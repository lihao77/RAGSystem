/**
 * Model Adapter API 调用模块。
 */

import { http } from './http.js';

const API_BASE = '/api/model-adapter'

export async function getProviderTypes() {
  const data = await http.get(`${API_BASE}/provider-types`)
  return data.data || []
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

function normalizeModelList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  const model = String(value || '').trim()
  return model ? [model] : []
}

function collectProviderModels(provider, task = 'chat') {
  const result = []
  const seen = new Set()
  const add = (modelName, taskName = '') => {
    const model = String(modelName || '').trim()
    if (!model || seen.has(model)) return
    result.push({ task: taskName, model })
    seen.add(model)
  }

  const modelMap = provider.model_map && typeof provider.model_map === 'object' ? provider.model_map : null
  const hasModelMap = modelMap && Object.keys(modelMap).length > 0
  if (modelMap) {
    Object.entries(modelMap).forEach(([taskName, value]) => {
      if (task !== null && taskName !== task) return
      normalizeModelList(value).forEach(model => add(model, taskName))
    })
  }

  if (task === null || (result.length === 0 && !hasModelMap)) {
    const fallbackTask = task === null ? '' : task
    normalizeModelList(provider.models).forEach(model => add(model, fallbackTask))
    normalizeModelList(provider.model).forEach(model => add(model, fallbackTask))
  }

  return result
}

export async function getAvailableModels(options = {}) {
  try {
    const providers = await getProviders()
    const models = []
    const seen = new Set()
    const effectiveTask = options.allTasks
      ? null
      : (Object.prototype.hasOwnProperty.call(options, 'task') ? options.task : 'chat')
    const includeTaskLabel = effectiveTask === null

    providers.forEach(provider => {
      const name = provider.name || provider.key || ''
      const ptype = provider.provider_type || ''
      const displayName = name + (ptype ? ` (${ptype})` : '')
      const providerModels = collectProviderModels(provider, effectiveTask)

      providerModels.forEach(({ task, model }) => {
        const value = `${name}|${ptype}|${model}`
        if (seen.has(value)) return
        seen.add(value)
        models.push({
          label: `${displayName} / ${includeTaskLabel && task ? `${task}: ` : ''}${model}`,
          value,
          provider: name,
          provider_type: ptype,
          task,
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

export async function checkProviderAvailability(providerKey) {
  return http.get(`${API_BASE}/providers/${encodeURIComponent(providerKey)}/check`)
}

export async function testProvider(provider, model, prompt = 'Hello', providerType = '', task = 'chat') {
  try {
    const data = await http.post(`${API_BASE}/test`, {
      provider,
      provider_type: providerType,
      model: normalizeModelList(model)[0] || '',
      prompt,
      task
    })

    return {
      ...data,
      response: data.response || data.data || null
    }
  } catch (error) {
    console.error('Error testing provider:', error)
    throw error
  }
}
