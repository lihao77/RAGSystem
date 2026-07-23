import { normalizeModelList } from './modelList.js';

const TASK_DEFINITIONS = [
  { task: 'chat', label: 'Chat', prompt: '请只回复 pong' },
  { task: 'embedding', label: 'Embedding', prompt: '测试向量化' },
  {
    task: 'rerank',
    label: 'Rerank',
    prompt: 'RAG 系统如何对召回结果重新排序？',
    documents: [
      { id: 'rerank-relevant', text: 'RAG 系统先召回候选文档，再使用 Rerank 模型按查询相关性重新排序。' },
      { id: 'rerank-unrelated', text: '今天的天气适合户外跑步。' },
    ],
  },
];

export function getProviderTestTargets(provider = {}) {
  const modelMap = provider.model_map && typeof provider.model_map === 'object'
    ? provider.model_map
    : {};
  const targets = TASK_DEFINITIONS.flatMap((definition) => {
    const model = normalizeModelList(modelMap[definition.task])[0];
    return model ? [{ ...definition, model }] : [];
  });
  if (targets.length > 0) return targets;

  const fallbackModel = normalizeModelList(provider.models)[0]
    || normalizeModelList(provider.model)[0]
    || '';
  return fallbackModel
    ? [{ ...TASK_DEFINITIONS[0], model: fallbackModel }]
    : [];
}

export function providerTestTaskLabel(task) {
  return TASK_DEFINITIONS.find((definition) => definition.task === task)?.label || String(task || 'Test');
}

export function summarizeProviderTestResult(target, result) {
  const latency = Number(result?.latency);
  const latencyText = Number.isFinite(latency) ? ` · ${latency.toFixed(2)}s` : '';

  if (target.task === 'embedding') {
    const vector = result?.embeddings?.[0];
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(Number(value)))) {
      throw new Error('Embedding 接口未返回有效向量');
    }
    return `返回 ${vector.length} 维向量${latencyText}`;
  }

  if (target.task === 'rerank') {
    const results = Array.isArray(result?.results) ? result.results : [];
    if (results.length === 0) throw new Error('Rerank 接口未返回排序结果');
    const relevantScore = scoreById(results, 'rerank-relevant');
    const unrelatedScore = scoreById(results, 'rerank-unrelated');
    if (relevantScore !== null && unrelatedScore !== null) {
      if (relevantScore <= unrelatedScore) {
        throw new Error(`Rerank 调用成功，但相关文档得分 ${formatScore(relevantScore)} 未高于无关文档 ${formatScore(unrelatedScore)}`);
      }
      return `相关 ${formatScore(relevantScore)} / 无关 ${formatScore(unrelatedScore)} · 排序正确${latencyText}`;
    }
    return `返回 ${results.length} 条排序结果${latencyText}`;
  }

  return `响应：${String(result?.content || '').slice(0, 80) || '调用成功'}${latencyText}`;
}

function scoreById(results, id) {
  const score = Number(results.find((item) => item?.id === id)?.score);
  return Number.isFinite(score) ? score : null;
}

function formatScore(score) {
  return Number(score).toFixed(4);
}
