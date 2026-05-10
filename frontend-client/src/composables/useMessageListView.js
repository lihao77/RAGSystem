import { computed } from 'vue';
import { copyToClipboard } from '../utils/clipboard';

export function useMessageListView({ messages, showToast }) {
  let messageKeyCounter = 0;

  const messageKey = (msg) => {
    if (msg._key == null) msg._key = `mk-${messageKeyCounter++}`;
    return msg._key;
  };

  const visibleMessages = computed(() => {
    const list = messages.value;
    if (!list.length) return [];

    const withSeq = list.filter((message) => message.seq != null);
    const summaryMsg = withSeq
      .filter((message) => message.metadata?.compression === true)
      .sort((a, b) => b.seq - a.seq)[0];

    if (!summaryMsg) return list;

    const replacesUpTo = summaryMsg.metadata?.replaces_up_to_seq;
    const cutoff = replacesUpTo != null ? replacesUpTo : summaryMsg.seq;
    const rest = list.filter((message) => (
      message.seq == null
      || (message.metadata?.compression !== true && message.seq > cutoff)
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
