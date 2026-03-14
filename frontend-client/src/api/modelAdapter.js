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

function getChatModels(provider) {
  const fromMap = provider.model_map?.chat
  if (fromMap != null) {
    if (Array.isArray(fromMap)) return fromMap.filter(Boolean)
    return [String(fromMap)]
  }
  if (provider.models && provider.models.length > 0) return provider.models
  if (provider.model) return [provider.model]
  return []
}

export async function getAvailableModels() {
  try {
    const providers = await getProviders()
    const models = []

    providers.forEach(provider => {
      const name = provider.name || provider.key || ''
      const ptype = provider.provider_type || ''
      const displayName = name + (ptype ? ` (${ptype})` : '')
      const chatModels = getChatModels(provider)

      chatModels.forEach(modelName => {
        const value = `${name}|${ptype}|${modelName}`
        models.push({
          label: `${displayName} / ${modelName}`,
          value,
          provider: name,
          provider_type: ptype,
          model: modelName
        })
      })

      if (chatModels.length === 0 && (provider.models?.length || provider.model)) {
        const fallback = provider.models?.[0] || provider.model
        const value = `${name}|${ptype}|${fallback}`
        models.push({
          label: `${displayName} / ${fallback}`,
          value,
          provider: name,
          provider_type: ptype,
          model: fallback
        })
      }
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

export async function testProvider(provider, model, prompt = 'Hello', providerType = '') {
  try {
    const response = await fetch(`${API_BASE}/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider,
        provider_type: providerType,
        model,
        prompt,
        task: 'chat'
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
