/**
 * LLM Adapter API 调用模块
 */

const API_BASE = '/api/llm-adapter';

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
 * 获取所有可用的 LLM 模型列表（provider/model 格式）
 * @returns {Promise<Array<{label: string, value: string, provider: string, model: string}>>}
 */
export async function getAvailableModels() {
  try {
    const providers = await getProviders();
    const models = [];

    providers.forEach(provider => {
      const providerName = provider.name;
      const providerModels = provider.models || [];

      // 如果有 models 列表，为每个 model 生成一个选项
      if (providerModels.length > 0) {
        providerModels.forEach(model => {
          models.push({
            label: `${providerName}/${model}`,
            value: `${providerName}/${model}`,
            provider: providerName,
            model: model
          });
        });
      } else if (provider.model) {
        // 降级：如果没有 models 列表但有单个 model，使用它
        models.push({
          label: `${providerName}/${provider.model}`,
          value: `${providerName}/${provider.model}`,
          provider: providerName,
          model: provider.model
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
        prompt
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
