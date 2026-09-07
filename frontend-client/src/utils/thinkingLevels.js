/**
 * 思考档位工具：档位文案 + provider 思考 descriptor（后端注入，API 格式 + thinking_kind）
 * 与模型级 thinking_levels 子集（目录 reasoning_options 的 effort 值域）的合成。
 * 可选档位以 descriptor 为准（agent-llm describeThinking 同源规则），不出现厂商名键表。
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

/** provider 思考形状（thinking_kind）手动声明选项；空 = 跟随 API 格式默认（openai 系 effort、anthropic 折叠 budget）。 */
export const THINKING_KIND_OPTIONS = [
  { value: '', label: '默认（跟随 API 格式）' },
  { value: 'effort', label: 'effort · 推理档位' },
  { value: 'budget', label: 'budget · token 预算' },
  { value: 'toggle', label: 'toggle · 仅开关' },
  { value: 'none', label: 'none · 不支持思考' },
];

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
 * provider 思考 descriptor + 模型条目子集 → 可选档位：
 * 模型声明子集（目录 effort 值域）时强度档位以子集（厂商真实枚举）为准，off 恒可用；
 * toggle 形状（厂商投票的多数默认）下带子集的模型升级为 effort 分级（如智谱 glm-5.3）；
 * budget 形状（anthropic 线，descriptor 已由后端折叠）菜单同样随子集收缩
 * （agent-llm describeThinking 同源规则）。注意 descriptor 是 provider 级（后端注入时
 * 不看模型子集），kind 与运行时可能不同（anthropic+toggle 此处 budget、运行时按子集
 * 升级 effort）——levels 三方恒一致，kind 仅用于选择器显隐，勿按其分支业务逻辑。
 */
export function thinkingCapabilityFor(provider, modelName) {
  const thinking = provider && provider.thinking && typeof provider.thinking === 'object' ? provider.thinking : null;
  if (!thinking || thinking.kind === 'none') return { kind: 'none', levels: [] };
  let levels = Array.isArray(thinking.levels) ? [...thinking.levels] : [];
  let kind = thinking.kind;
  if ((kind === 'effort' || kind === 'toggle' || kind === 'budget') && modelName) {
    const entry = Array.isArray(provider.models)
      ? provider.models.find((item) => String(item?.name || '') === modelName)
      : null;
    const subset = normalizeThinkingLevels(entry?.thinking_levels);
    if (subset.length) {
      if (kind === 'toggle') kind = 'effort';
      levels = ['off', ...subset];
    }
  }
  return { kind, levels };
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
