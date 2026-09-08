/**
 * 思考档位工具：档位文案 + 思考形状选项（格式能力矩阵 × 目录推荐）与
 * 模型级 thinking descriptor（后端按模型条目注入：describeThinking 显式定形，
 * 无推断）。可选档位以 descriptor 为准，不出现厂商名键表。
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

/** effort 系强度档位全集（模型级 thinking_levels 子集的合法值域）；off 是通用开关不入子集。 */
export const THINKING_STRENGTH_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 格式 × 思考形状能力矩阵（与后端 agent-llm THINKING_KINDS_BY_FORMAT 同构）：
 * 形状是模型级显式声明（每条模型必选），选项只列该格式下真能落线的形状。
 */
export const THINKING_KINDS_BY_FORMAT = {
  anthropic: ['budget', 'effort', 'none'],
  openai_chat: ['effort', 'toggle', 'none'],
  openai_resp: ['effort', 'toggle', 'none'],
  gemini: ['none'],
};

export const THINKING_KIND_LABELS = {
  effort: 'effort · 推理档位',
  budget: 'budget · token 预算',
  toggle: 'toggle · 仅开关',
  none: 'none · 不支持思考',
};

/**
 * 思考形状选项（模型条目必选字段）：按 Provider 的 API 格式过滤能力矩阵；
 * 目录命中模型可传入其可接受集与推荐形状——推荐项打 ★ 前缀，其余可接受项
 * 标记 catalogAccepted（UI 可弱化展示），用户仍可改选矩阵内任意形状。
 */
export function thinkingKindOptions(apiFormat, acceptedKinds = [], recommendedKind = null) {
  const allowed = THINKING_KINDS_BY_FORMAT[apiFormat] ?? [];
  const accepted = new Set(
    (Array.isArray(acceptedKinds) ? acceptedKinds : []).filter((kind) => allowed.includes(kind)),
  );
  return allowed.map((value) => ({
    value,
    label: (recommendedKind === value ? '★ ' : '') + THINKING_KIND_LABELS[value],
    recommended: recommendedKind === value,
    catalogAccepted: accepted.has(value),
  }));
}

/** 思考档位子集归一：小写 trim、只留已知强度档位、按全集顺序输出；非数组/过滤后为空 → []。 */
export function normalizeThinkingLevels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const token = String(item || '').trim().toLowerCase();
    if (THINKING_STRENGTH_LEVELS.includes(token)) seen.add(token);
  }
  return THINKING_STRENGTH_LEVELS.filter((token) => seen.has(token));
}

/**
 * 模型思考能力：直读后端注入的模型条目 descriptor（/providers 响应逐模型注入
 * thinking: {kind, levels}——describeThinking 按条目 thinking_kind 显式定形，
 * 含档位子集收缩；前端不再镜像推断）。无条目/descriptor = 无思考选项。
 */
export function thinkingCapabilityFor(provider, modelName) {
  const entry = Array.isArray(provider?.models)
    ? provider.models.find((item) => String(item?.name || '') === modelName)
    : null;
  const thinking = entry?.thinking && typeof entry.thinking === 'object' ? entry.thinking : null;
  if (!thinking || thinking.kind === 'none') return { kind: 'none', levels: [] };
  return {
    kind: thinking.kind,
    levels: Array.isArray(thinking.levels) ? [...thinking.levels] : [],
  };
}

/** 档位集合 → 下拉选项（含"模型默认"首位；档位缺失时仅"模型默认"）。 */
export function thinkingOptionsFromLevels(levels) {
  return [
    { value: '', label: '模型默认' },
    ...(Array.isArray(levels) ? levels : [])
      .map((level) => THINKING_LEVEL_OPTIONS.find((option) => option.value === level))
      .filter(Boolean),
  ];
}
