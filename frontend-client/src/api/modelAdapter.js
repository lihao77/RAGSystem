/**
 * Model Adapter API 调用模块。
 */

const API_BASE = '/api/model-adapter'

export async function getProviderTypes() {
  const response = await fetch(`${API_BASE}/provider-types`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || data.message || '获取失败')
  return data.data || []
}

export async function getProviders() {
  try {
    const response = await fetch(`${API_BASE}/providers`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.message || 'Failed to fetch providers')
    }

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

export async function createProvider(data) {
  const response = await fetch(`${API_BASE}/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
  const json = await response.json()
  if (!response.ok) throw new Error(json.detail || json.message || '创建失败')
  return json
}

export async function updateProvider(providerKey, data) {
  const response = await fetch(`${API_BASE}/providers/${encodeURIComponent(providerKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
  const json = await response.json()
  if (!response.ok) throw new Error(json.detail || json.message || '更新失败')
  return json
}

export async function reorderProviders(providerKeys) {
  const response = await fetch(`${API_BASE}/providers/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider_keys: providerKeys })
  })
  const json = await response.json()
  if (!response.ok) throw new Error(json.detail || json.message || '排序保存失败')
  return json
}

export async function deleteProvider(providerKey) {
  const response = await fetch(`${API_BASE}/providers/${encodeURIComponent(providerKey)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }
  })
  const json = await response.json()
  if (!response.ok) throw new Error(json.detail || json.message || '删除失败')
  return json
}

export async function checkProviderAvailability(providerKey) {
  const response = await fetch(`${API_BASE}/providers/${encodeURIComponent(providerKey)}/check`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  })
  const json = await response.json()
  if (!response.ok) throw new Error(json.detail || json.message || '检查失败')
  return json
}

export async function testProvider(provider, model, prompt = 'Hello', providerType = '', task = 'chat') {
  try {
    const response = await fetch(`${API_BASE}/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider,
        provider_type: providerType,
        model: normalizeModelList(model)[0] || '',
        prompt,
        task
      })
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.message || 'Test failed')
    }

    return {
      ...data,
      response: data.response || data.data || null
    }
  } catch (error) {
    console.error('Error testing provider:', error)
    throw error
  }
}
