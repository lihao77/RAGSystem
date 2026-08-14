// @ts-check
import { computed, reactive } from 'vue';
import { isImageAttachment, isLocalAttachment } from '../utils/sessionAttachments.js';
import { imageDescribeActive, pluginEventState } from './usePluginEvents.js';

/**
 * 发送带图消息 → 消息落库之间的"幽灵消息"快照。
 *
 * 发送成功后用户消息不再乐观上屏（需经后端图片识别变换才落库投影），这段空窗里
 * 用本快照在消息列表底部渲染 pending 态用户气泡（PendingImageMessage），
 * 落库（用户消息数增加）/ 发送失败 / 会话切换 / 兜底超时时清除。
 *
 * 缩略图 URL 生命周期：本地附件的 preview_url 会在 materialize 时被 revoke，
 * 因此捕获时为本地附件新建独立 object URL（owned），由本模块负责释放。
 */

/** 快照兜底存活时限：覆盖后端 image_tools.timeout_seconds（默认 60s）+ 识别完成到落库的余量。 */
const PENDING_IMAGE_SEND_STALE_MS = 90_000;

/** @typedef {{ key: string, url: string, owned: boolean, name: string }} PendingImageThumb */

export const pendingImageSendState = reactive({
  active: false,
  text: '',
  /** @type {PendingImageThumb[]} */
  thumbs: [],
  startedAt: 0,
  /**
   * 捕获时刻的 lastOutcome 引用基线：completed 每次写入新对象，
   * 引用变化即说明"本次"识别已完成（比时间戳比较可靠，无同毫秒误判）。
   * @type {{ total: number, described: number, failed: number, at: number } | null}
   */
  baselineOutcome: null,
});

/** @type {ReturnType<typeof setTimeout> | null} */
let staleTimer = null;

const clearStaleTimer = () => {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = null;
};

const armStaleTimer = () => {
  clearStaleTimer();
  // 落库帧丢失/后端卡住的兜底：清除快照，避免幽灵气泡挂死。
  staleTimer = setTimeout(() => clearPendingImageSend(), PENDING_IMAGE_SEND_STALE_MS);
};

const releaseThumbs = () => {
  for (const thumb of pendingImageSendState.thumbs) {
    if (thumb.owned && thumb.url) URL.revokeObjectURL(thumb.url);
  }
};

/** 清除幽灵气泡快照（落库 / 发送失败 / 会话切换 / 兜底超时）。 */
export const clearPendingImageSend = () => {
  clearStaleTimer();
  releaseThumbs();
  pendingImageSendState.active = false;
  pendingImageSendState.text = '';
  pendingImageSendState.thumbs = [];
  pendingImageSendState.startedAt = 0;
  pendingImageSendState.baselineOutcome = null;
};

/**
 * 发送前捕获带图消息快照（取值优先级需与 sendNow 一致：payload 优先于输入框草稿）。
 * 无图片附件时不捕获，返回 false。
 * @param {{ content?: string, attachments?: Array<Record<string, any>>, getAttachmentPreviewUrl?: (attachment: Record<string, any>) => string }} input
 * @returns {boolean} 是否已捕获
 */
export const capturePendingImageSend = ({ content = '', attachments = [], getAttachmentPreviewUrl } = {}) => {
  const images = (Array.isArray(attachments) ? attachments : []).filter(isImageAttachment);
  if (!images.length) return false;

  clearPendingImageSend(); // 防御：上一次快照异常残留时先释放其 object URLs

  /** @type {PendingImageThumb[]} */
  const thumbs = [];
  images.forEach((attachment, index) => {
    const name = attachment.original_name || attachment.stored_name || `图片 ${index + 1}`;
    if (isLocalAttachment(attachment) && attachment.file instanceof File) {
      thumbs.push({
        key: attachment.local_id || `img-${index}`,
        url: URL.createObjectURL(attachment.file),
        owned: true,
        name,
      });
      return;
    }
    // 会话文件附件：认证下载 URL（非 object URL，无需释放）。
    const url = typeof getAttachmentPreviewUrl === 'function' ? getAttachmentPreviewUrl(attachment) : '';
    if (url) {
      thumbs.push({
        key: attachment.file_id || attachment.id || `img-${index}`,
        url,
        owned: false,
        name,
      });
    }
  });

  pendingImageSendState.text = String(content || '');
  pendingImageSendState.thumbs = thumbs;
  pendingImageSendState.startedAt = Date.now();
  pendingImageSendState.baselineOutcome = pluginEventState.imageDescribe.lastOutcome;
  pendingImageSendState.active = true;
  armStaleTimer();
  return true;
};

/** 幽灵气泡阶段：sending（默认）→ recognizing（message 识别进行中）→ done（completed 到达、待落库）。 */
export const pendingImagePhase = computed(() => {
  if (!pendingImageSendState.active) return 'sending';
  const describe = pluginEventState.imageDescribe;
  const completedThisSend = describe.lastOutcome && describe.lastOutcome !== pendingImageSendState.baselineOutcome;
  if (completedThisSend && !imageDescribeActive.value) {
    return 'done';
  }
  if (imageDescribeActive.value && describe.source === 'message') return 'recognizing';
  return 'sending';
});

/** 逐张缩略图状态（progress 事件 index 与发送时图片附件顺序一致）：'pending' | 'ok' | 'failed'。 */
export const pendingImageThumbStates = computed(() => {
  const items = pluginEventState.imageDescribe.items;
  return pendingImageSendState.thumbs.map((_, index) => items.get(index) || 'pending');
});

export function usePendingImageSend() {
  return {
    pendingImageSendState,
    pendingImagePhase,
    pendingImageThumbStates,
    capturePendingImageSend,
    clearPendingImageSend,
  };
}
