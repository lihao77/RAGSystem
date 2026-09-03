import { computed } from 'vue';
import { copyToClipboard } from '../utils/clipboard.js';

export const findRetryMessage = (items, index, canReviseMessage = () => true) => {
  const nearestUserMessage = (Array.isArray(items) ? items : [])
    .slice(0, index)
    .findLast(message => message?.role === 'user') || null;
  if (!nearestUserMessage || nearestUserMessage.metadata?.agent_message === true) return null;
  return canReviseMessage(nearestUserMessage) ? nearestUserMessage : null;
};

// 刷新恢复用的派生横线：对象保持稳定引用，messageKey 只分配一次 _key，
// 避免 computed 重算时 key 变化导致重挂/动画重启。与 reducer 帧驱动的瞬态项
// 同构（metadata.msg_type = context_compression_pending），渲染路径一致。
const DERIVED_COMPACT_PENDING_ITEM = {
  role: 'system',
  content: '正在压缩…',
  content_parts: [{ type: 'text', text: '正在压缩…' }],
  metadata: { msg_type: 'context_compression_pending' },
};

export function useMessageListView({ messages, showToast, sessionRuntime, isRootView }) {
  let messageKeyCounter = 0;

  const messageKey = (msg) => {
    if (msg._key == null) msg._key = `mk-${messageKeyCounter++}`;
    return msg._key;
  };

  // 压缩横线只属于根会话：事件帧可能落在当前选中的子参与者列表里（reducer 按当前视图
  // messages 插入），root 压缩期间切到子视图时在此过滤，切回 root 自然复现。
  // 未传 isRootView 的调用方（测试/历史）保持可见，兼容旧约定。
  const rootViewVisible = () => !isRootView || isRootView.value !== false;

  const visibleMessages = computed(() => {
    const list = messages.value;
    if (!list.length) return [];

    // 压缩只影响发给 LLM 的上下文，不影响展示：原始对话完整渲染，
    // 摘要消息本身不进列表（手动 /compact 的"压缩完成：N 条"由 command_result 承载）。
    const withoutSummary = list.filter((message) => message.metadata?.msg_type !== 'context_compression_summary');

    if (!rootViewVisible()) {
      return withoutSummary.filter((message) => message.metadata?.msg_type !== 'context_compression_pending');
    }

    // 刷新恢复：手动 /compact 的 maintenance(compact) 租约是持久事实，连接首帧的 runtime
    // 快照即携带；瞬态横线随刷新丢失后由此派生补挂，租约结束（完成/释放/过期）自动消失。
    // 帧驱动瞬态项已在列表时去重，不重复挂。已知无害时序：compression_summary 清掉帧横线
    // 后、租约释放快照到达前（约一个快照 RTT），派生横线会短暂复现一次，自收敛。
    if (sessionRuntime?.value?.maintenance?.kind === 'compact'
      && !withoutSummary.some((message) => message.metadata?.msg_type === 'context_compression_pending')) {
      return [...withoutSummary, DERIVED_COMPACT_PENDING_ITEM];
    }
    return withoutSummary;
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
