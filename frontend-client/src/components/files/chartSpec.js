/**
 * 交互图表数据（file_ref 引用的 ECharts option JSON）的解析与净化。
 *
 * 模型产出的 option 是不可信输入：ECharts 的 tooltip/label 默认以 HTML DOM 渲染富文本，
 * 字符串字段里的标记会被直接注入页面。因此进入渲染器前统一净化：
 * - 所有字符串转义 `<`（模型可用 ECharts 原生 `{a}`/富文本模板，不需要 HTML）；
 * - 链接类键（link/href/src/url）只放行 http(s)；
 * - series 类型白名单（与 ChartRenderer.vue 实际注册的图表类型对齐，改动需两侧同步）；
 * - 节点数/深度预算，防构造深度爆炸或超大结构。
 */

/** 与 ChartRenderer.vue 中 echarts.use 注册的 BarChart/LineChart/PieChart/ScatterChart 对齐。 */
export const SERIES_TYPE_WHITELIST = ['line', 'bar', 'pie', 'scatter'];

const MAX_NODES = 20000;
const MAX_DEPTH = 12;
const URL_KEYS = new Set(['link', 'href', 'src', 'url']);
const DROP = Symbol('chart-spec-drop');

class ChartSpecBudgetError extends Error {}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 净化单个节点，返回新结构；不可保留的值返回 DROP 哨兵。 */
function sanitizeNode(node, depth, budget) {
  if (node === null) return null;
  const type = typeof node;
  if (type === 'boolean') return node;
  if (type === 'number') return Number.isFinite(node) ? node : DROP;
  if (type === 'string') {
    // 1e999 一类溢出场景由 number 分支处理；字符串统一转义防 HTML 注入（见文件头注释）
    return node.includes('<') ? node.replaceAll('<', '&lt;') : node;
  }
  if (type !== 'object') return DROP;
  if (depth > MAX_DEPTH) return DROP;
  budget.count += 1;
  if (budget.count > MAX_NODES) throw new ChartSpecBudgetError();

  if (Array.isArray(node)) {
    const items = [];
    for (const item of node) {
      const sanitized = sanitizeNode(item, depth + 1, budget);
      if (sanitized !== DROP) items.push(sanitized);
    }
    return items;
  }

  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (URL_KEYS.has(key)) {
      if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;
    }
    const sanitized = sanitizeNode(value, depth + 1, budget);
    if (sanitized !== DROP) result[key] = sanitized;
  }
  return result;
}

/**
 * 解析并净化图表文件内容。
 * 接受两种形态：裸 option 对象，或 `{ renderer: 'echarts', version?: 1, option: {...} }` 包装。
 * @returns {{ ok: true, option: object } | { ok: false, reason: string }}
 */
export function parseChartSpec(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, reason: '不是合法的 JSON' };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: '顶层必须是对象' };

  let option = parsed;
  if (isPlainObject(parsed.option) && ('renderer' in parsed || 'schema' in parsed || '$schema' in parsed)) {
    if (typeof parsed.renderer === 'string' && parsed.renderer.toLowerCase() !== 'echarts') {
      return { ok: false, reason: `不支持的 renderer: ${parsed.renderer}` };
    }
    option = parsed.option;
  }

  let sanitized;
  try {
    sanitized = sanitizeNode(option, 0, { count: 0 });
  } catch (error) {
    if (error instanceof ChartSpecBudgetError) return { ok: false, reason: '图表数据超出规模上限' };
    throw error;
  }
  if (!isPlainObject(sanitized)) return { ok: false, reason: 'option 必须是对象' };

  if (Array.isArray(sanitized.series)) {
    sanitized.series = sanitized.series.filter(
      (item) => isPlainObject(item) && SERIES_TYPE_WHITELIST.includes(item.type),
    );
  }
  if (!sanitized.series?.length) {
    return { ok: false, reason: `缺少可用 series（仅支持 ${SERIES_TYPE_WHITELIST.join('/')}）` };
  }
  return { ok: true, option: sanitized };
}
