import { computed } from 'vue';
import { copyToClipboard } from '../utils/clipboard.js';

export const findRetryMessage = (items, index, canReviseMessage = () => true) => {
  const nearestUserMessage = (Array.isArray(items) ? items : [])
    .slice(0, index)
    .findLast(message => message?.role === 'user') || null;
  if (!nearestUserMessage || nearestUserMessage.metadata?.agent_message === true) return null;
  return canReviseMessage(nearestUserMessage) ? nearestUserMessage : null;
};

export function useMessageListView({ messages, showToast }) {
  let messageKeyCounter = 0;

  const messageKey = (msg) => {
    if (msg._key == null) msg._key = `mk-${messageKeyCounter++}`;
    return msg._key;
  };

  const visibleMessages = computed(() => {
    const list = messages.value;
    if (!list.length) return [];

    // Follow-ups and agent messages are ordinary visible conversation boundaries.
    // Their execution segment is loaded by the same carrier as assistant messages.
    const reordered = list;

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
    copyMessage,
  };
}
