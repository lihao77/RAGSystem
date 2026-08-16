/**
 * 思考档位表（agent 配置表单用）—— 与 agent-llm describeThinking 的档位集合保持一致。
 * 档位配置入口在 agent 的 llm_tiers（provider 不定义思考强度）。
 */

export const THINKING_LEVEL_OPTIONS = [
  { value: '', label: '模型默认', description: '不设置默认档位，由模型默认行为决定' },
  { value: 'off', label: '关闭', description: '不进行扩展思考，响应最快' },
  { value: 'on', label: '开启', description: '启用扩展思考（开关型模型，不分级）' },
  { value: 'minimal', label: '最低', description: '最小限度思考，速度优先' },
  { value: 'low', label: '低', description: '轻度思考，速度与质量均衡' },
  { value: 'medium', label: '中', description: '适度思考，适合常规复杂任务' },
  { value: 'high', label: '高', description: '深度思考，适合复杂推理任务' },
  { value: 'xhigh', label: '最高', description: '超深度思考，适合高难度推理任务' },
  { value: 'max', label: '最大', description: '最大强度思考，适合极限复杂任务' },
];

/** provider_type → 可选档位（不含"模型默认"；与 agent-llm THINKING_LEVELS_BY_PROVIDER_TYPE 一致）。 */
export const REASONING_LEVELS_BY_TYPE = {
  openai_resp: ['off', 'minimal', 'low', 'medium', 'high'],
  openai_chat: ['off', 'minimal', 'low', 'medium', 'high'],
  openai_proxy: ['off', 'minimal', 'low', 'medium', 'high'],
  anthropic: ['off', 'low', 'medium', 'high'],
  deepseek: ['off', 'low', 'high', 'max'],
  openrouter: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  modelscope: ['off', 'on'],
};

/**
 * 按 provider_type 生成思考档位下拉选项（含"模型默认"）。
 * 未知类型返回仅"模型默认"的选项。
 */
export function thinkingOptionsFor(providerType) {
  const levels = REASONING_LEVELS_BY_TYPE[providerType] || [];
  return [
    { value: '', label: '模型默认' },
    ...levels
      .map(level => THINKING_LEVEL_OPTIONS.find(option => option.value === level))
      .filter(Boolean),
  ];
}
