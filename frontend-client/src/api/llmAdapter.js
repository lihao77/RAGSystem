/**
 * Model Adapter API 调用模块（兼容旧 llm adapter 调用）
 */

const API_BASE = '/api/model-adapter';

/**
 * 获取所有已配置的 LLM Providers
 * @returns {Promise<Array>} Provider 列表
 */
export async function getProviders() {
  try {
    const response = await fetch(`${API_BASE}/providers`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to fetch providers');
    }

    return data.providers || [];
  } catch (error) {
    console.error('Error fetching providers:', error);
    throw error;
  }
}

/**
 * 从 provider 配置中取出 chat 模型列表（model_map.chat 或 models 或 model）
 */
function getChatModels(provider) {
  const fromMap = provider.model_map?.chat;
  if (fromMap != null) {
    if (Array.isArray(fromMap)) return fromMap.filter(Boolean);
    return [String(fromMap)];
  }
  if (provider.models && provider.models.length > 0) return provider.models;
  if (provider.model) return [provider.model];
  return [];
}

/**
 * 获取所有可用的 LLM 模型列表（使用复合键 provider_key，value 为 provider_key/model）
 * @returns {Promise<Array<{label: string, value: string, provider: string, model: string}>>}
 */
export async function getAvailableModels() {
  try {
    const providers = await getProviders();
    const models = [];

    providers.forEach(provider => {
      const name = provider.name || provider.key || '';
      const ptype = provider.provider_type || '';
      const displayName = name + (ptype ? ` (${ptype})` : '');
      const chatModels = getChatModels(provider);

      chatModels.forEach(modelName => {
        const value = `${name}|${ptype}|${modelName}`;
        models.push({
          label: `${displayName} / ${modelName}`,
          value,
          provider: name,
          provider_type: ptype,
          model: modelName
        });
      });

      if (chatModels.length === 0 && (provider.models?.length || provider.model)) {
        const fallback = provider.models?.[0] || provider.model;
        const value = `${name}|${ptype}|${fallback}`;
        models.push({
          label: `${displayName} / ${fallback}`,
          value,
          provider: name,
          provider_type: ptype,
          model: fallback
        });
      }
    });

    return models;
  } catch (error) {
    console.error('Error getting available models:', error);
    return [];
  }
}

/**
 * 测试 Provider 连接
 * @param {string} provider - Provider 名称
 * @param {string} model - 模型名称（可选）
 * @param {string} prompt - 测试提示词
 * @returns {Promise<Object>} 测试结果
 */
export async function testProvider(provider, model, prompt = 'Hello') {
  try {
    const response = await fetch(`${API_BASE}/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider,
        model,
        prompt,
        // 显式指定任务类型，兼容 ModelAdapter 的多任务测试接口
        task: 'chat'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Test failed');
    }

    return data;
  } catch (error) {
    console.error('Error testing provider:', error);
    throw error;
  }
}
