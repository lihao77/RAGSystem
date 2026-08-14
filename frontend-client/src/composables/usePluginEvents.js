// @ts-check
import { computed, reactive } from 'vue';

/**
 * 插件下行事件（protocol plugin_event 帧）状态中心。
 *
 * dispatcher 把校验过的 payload 交给 handlePluginEventPayload：
 *   • latest 记录各插件最近一次事件（通用消费位，供后续插件 UI 使用）；
 *   • imageDescribe 归约 image-tools 的图片描述进度（发送前变换 / run 内 view_image），
 *     驱动 composer 的"正在识别图片"提示——状态完全由后端事件驱动，
 *     取代了此前"带图发送即盲显 + 超时清除"的启发式。
 *
 * 事件名与 plugins/backend-plugin-image-tools/src/plugin.ts 的 IMAGE_DESCRIBE_EVENTS 对齐。
 */

const IMAGE_TOOLS_PLUGIN_ID = '@ragsystem/backend-plugin-image-tools';
const IMAGE_DESCRIBE_EVENTS = {
  started: 'image.describe_started',
  progress: 'image.describe_progress',
  completed: 'image.describe_completed',
};

/**
 * started 后若 completed 帧丢失（WS 抖动/断连）的兜底收尾时限。
 * 发送链路已无硬性变换截止，单图描述由后端 image_tools.timeout_seconds（默认 60s）
 * 自约束——取 75s（60s + 15s 余量）覆盖正常路径，又不至于让提示条挂死。
 */
export const IMAGE_DESCRIBE_STALE_MS = 75_000;

/** @typedef {{ plugin_id: string, event: string, data: unknown, delivery?: string, at: number }} PluginEventRecord */
/** @typedef {{ total: number, described: number, failed: number, at: number }} ImageDescribeOutcome */

export const pluginEventState = reactive({
  /** @type {Map<string, PluginEventRecord>} 各插件最近一次事件（key: `${plugin_id}:${event}`）。 */
  latest: new Map(),
  imageDescribe: {
    /** 进行中的描述操作数（message 变换与 run 内 view_image 可能并行，引用计数）。 */
    activeOps: 0,
    total: 0,
    done: 0,
    failed: 0,
    /**
     * 逐张图片的识别结果（key: progress 事件的 index，与发送时图片附件顺序一致）。
     * 仅记录 source === 'message' 的帧；completed 后保留（幽灵气泡完成态展示），reset 时清空。
     * @type {Map<number, 'ok' | 'failed'>}
     */
    items: new Map(),
    /** @type {string | null} 最近一次的来源（message / view_image）。 */
    source: /** @type {string | null} */ (null),
    /** @type {ImageDescribeOutcome | null} 最近一次 completed 的权威结果（失败提示用）。 */
    lastOutcome: /** @type {ImageDescribeOutcome | null} */ (null),
  },
});

/** @type {ReturnType<typeof setTimeout> | null} */
let imageDescribeStaleTimer = null;

const clearImageDescribeStaleTimer = () => {
  if (imageDescribeStaleTimer) clearTimeout(imageDescribeStaleTimer);
  imageDescribeStaleTimer = null;
};

const armImageDescribeStaleTimer = () => {
  clearImageDescribeStaleTimer();
  imageDescribeStaleTimer = setTimeout(() => {
    // completed 帧丢失的兜底：直接收尾，避免提示条挂死。
    resetImageDescribe();
  }, IMAGE_DESCRIBE_STALE_MS);
};

/** 结束图片描述状态（completed 到达 / 新用户消息落库 / 兜底超时）。 */
export const resetImageDescribe = () => {
  clearImageDescribeStaleTimer();
  pluginEventState.imageDescribe.activeOps = 0;
  pluginEventState.imageDescribe.total = 0;
  pluginEventState.imageDescribe.done = 0;
  pluginEventState.imageDescribe.failed = 0;
  pluginEventState.imageDescribe.items.clear();
  pluginEventState.imageDescribe.source = null;
};

/** 会话切换时清空全部插件事件状态。 */
export const resetPluginEventsState = () => {
  pluginEventState.latest.clear();
  pluginEventState.imageDescribe.lastOutcome = null;
  resetImageDescribe();
};

/** @param {unknown} data @returns {Record<string, any>} */
const asRecord = data => (data && typeof data === 'object' && !Array.isArray(data) ? data : /** @type {Record<string, any>} */ ({}));

/** @param {unknown} value @returns {number} */
const asCount = value => {
  const num = Number(value);
  return Number.isSafeInteger(num) && num >= 0 ? num : 0;
};

/** @param {unknown} value @returns {number} 非法时返回 -1（区别于合法的 0）。 */
const asIndex = value => {
  const num = Number(value);
  return Number.isSafeInteger(num) && num >= 0 ? num : -1;
};

/**
 * @param {string} event
 * @param {unknown} rawData
 */
const applyImageDescribeEvent = (event, rawData) => {
  const data = asRecord(rawData);
  const state = pluginEventState.imageDescribe;
  if (typeof data.source === 'string' && data.source) state.source = data.source;

  if (event === IMAGE_DESCRIBE_EVENTS.started) {
    state.activeOps += 1;
    state.total += asCount(data.total);
    armImageDescribeStaleTimer();
    return;
  }
  if (event === IMAGE_DESCRIBE_EVENTS.progress) {
    if (state.activeOps === 0) return; // 无 started 的迟到帧（断连期间的漏帧）直接忽略
    state.done += 1;
    if (data.ok !== true) state.failed += 1;
    if (state.source === 'message') {
      // 逐张结果按 index 对齐发送时图片附件顺序（幽灵气泡缩略图进度用）；缺 index 时按完成序兜底。
      const index = asIndex(data.index);
      state.items.set(index >= 0 ? index : state.done - 1, data.ok === true ? 'ok' : 'failed');
    }
    armImageDescribeStaleTimer();
    return;
  }
  if (event === IMAGE_DESCRIBE_EVENTS.completed) {
    const total = asCount(data.total);
    state.lastOutcome = {
      total,
      described: asCount(data.described),
      failed: asCount(data.failed),
      at: Date.now(),
    };
    state.activeOps = Math.max(0, state.activeOps - 1);
    if (state.activeOps === 0) {
      clearImageDescribeStaleTimer();
      state.total = 0;
      state.done = 0;
      state.failed = 0;
    }
  }
};

/**
 * plugin_event 入口（dispatcher 调用）。payload 已过 ServerToClientEnvelopeSchema 校验。
 * @param {unknown} payload
 */
export const handlePluginEventPayload = payload => {
  const record = asRecord(payload);
  const pluginId = typeof record.plugin_id === 'string' ? record.plugin_id : '';
  const event = typeof record.event === 'string' ? record.event : '';
  if (!pluginId || !event) return;

  pluginEventState.latest.set(`${pluginId}:${event}`, {
    plugin_id: pluginId,
    event,
    data: record.data,
    ...(typeof record.delivery === 'string' ? { delivery: record.delivery } : {}),
    at: Date.now(),
  });

  if (pluginId === IMAGE_TOOLS_PLUGIN_ID) applyImageDescribeEvent(event, record.data);
};

/** 图片描述是否进行中（驱动 composer 提示条）。 */
export const imageDescribeActive = computed(() => pluginEventState.imageDescribe.activeOps > 0);

/** 多图进度（仅进行中且总数 >1 时有值）：{ done, total }。 */
export const imageDescribeProgress = computed(() => {
  const state = pluginEventState.imageDescribe;
  return state.activeOps > 0 && state.total > 1 ? { done: state.done, total: state.total } : null;
});

export function usePluginEvents() {
  return {
    pluginEventState,
    imageDescribeActive,
    imageDescribeProgress,
    handlePluginEventPayload,
    resetImageDescribe,
    resetPluginEventsState,
  };
}
