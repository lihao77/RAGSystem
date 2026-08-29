// 内核 Provider 体系只承载 chat（embedding/rerank 归知识库插件自管模型服务）。
const TASK_DEFINITIONS = [
  { task: 'chat', label: 'Chat', prompt: '请只回复 pong' },
];

/** 每个已配置模型一个可测目标（模型即测试单元，运行参数取自模型条目）。 */
export function getProviderTestTargets(provider = {}) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models
    .map((entry) => String(entry?.name || '').trim())
    .filter(Boolean)
    .map((model) => ({ ...TASK_DEFINITIONS[0], model }));
}

export function providerTestTaskLabel(task) {
  return TASK_DEFINITIONS.find((definition) => definition.task === task)?.label || String(task || 'Test');
}

export function summarizeProviderTestResult(target, result) {
  const latency = Number(result?.latency);
  const latencyText = Number.isFinite(latency) ? ` · ${latency.toFixed(2)}s` : '';
  return `响应：${String(result?.content || '').slice(0, 80) || '调用成功'}${latencyText}`;
}
