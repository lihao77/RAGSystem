import { computed } from 'vue';
import { copyToClipboard } from '../utils/clipboard.js';

/**
 * run 内注入消息来源(进 executionTree 的 injection 节点)。
 * 第一版只含 followup(用户在 run 进行中插话,注入当前 run)。
 * background_notification 走通道 A(idle 触发独立 run,是 run 起点非注入)顶层显示;
 * 待后端 refresh 激活通道 B(通知注入当前 run)后,再区分 A/B 通知让通道 B 进 injection 节点。
 */
const INJECTION_SOURCES = new Set(['running_session']);

const isRunInjection = (message) => INJECTION_SOURCES.has(message?.metadata?.source || '')
  && Boolean(message?.metadata?.consumed_by_run_id || message?.metadata?.run_id);

export const findRetryMessage = (items, index, canReviseMessage = () => true) => {
  const nearestUserMessage = (Array.isArray(items) ? items : [])
    .slice(0, index)
    .findLast(message => message?.role === 'user') || null;
  if (!nearestUserMessage || nearestUserMessage.metadata?.agent_message === true) return null;
  return canReviseMessage(nearestUserMessage) ? nearestUserMessage : null;
};

const groupInjectionsByRunId = (items) => {
  const map = {};
  for (const message of items) {
    if (!isRunInjection(message)) continue;
    const runId = message.metadata?.consumed_by_run_id || message.metadata?.run_id;
    if (!runId) continue;
    if (!map[runId]) map[runId] = [];
    map[runId].push(message);
  }
  for (const runId of Object.keys(map)) {
    map[runId].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }
  return map;
};

export function useMessageListView({ messages, showToast }) {
  let messageKeyCounter = 0;

  const messageKey = (msg) => {
    if (msg._key == null) msg._key = `mk-${messageKeyCounter++}`;
    return msg._key;
  };

  /**
   * 按 run_id 聚合注入消息:供对应 assistant message 的 executionTree 消费(buildExecutionTree 第二参)。
   * 注入消息 = metadata.source ∈ INJECTION_SOURCES 且带 run_id。按 seq 升序(同 run 多条注入的时间线)。
   */
  const injectionsByRunId = computed(() => {
    return groupInjectionsByRunId(messages.value);
  });

  const visibleMessages = computed(() => {
    const list = messages.value;
    if (!list.length) return [];

    // run 内补充只显示于 WPE 执行时间线，不能作为主会话消息气泡渲染。
    const reordered = list.filter(message => !isRunInjection(message));

    // compression 摘要折叠(对 followup 重排后的列表)
    const withSeq = reordered.filter((message) => message.seq != null);
    const summaryMsg = withSeq
      .filter((message) => message.metadata?.msg_type === 'context_compression_summary')
      .sort((a, b) => b.seq - a.seq)[0];

    if (!summaryMsg) return reordered;

    const replacesUpTo = summaryMsg.metadata?.replaces_up_to_seq;
    const cutoff = replacesUpTo != null ? replacesUpTo : summaryMsg.seq;
    const rest = reordered.filter((message) => (
      message.seq == null
      || (message.metadata?.msg_type !== 'context_compression_summary' && message.seq > cutoff)
    ));

    return [summaryMsg, ...rest];
  });

  const copyMessage = async (msg) => {
    const text = (msg.content || '').trim();
    if (!text) {
      showToast('无内容可复制');
      return;
    }

    const ok = await copyToClipboard(text);
    showToast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : null);
  };

  return {
    messageKey,
    visibleMessages,
    injectionsByRunId,
    copyMessage,
  };
}
