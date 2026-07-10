import { computed } from 'vue';
import { copyToClipboard } from '../utils/clipboard';

/**
 * run 内注入消息来源(进 executionTree 的 injection 节点)。
 * 第一版只含 followup(用户在 run 进行中插话,注入当前 run)。
 * background_notification 走通道 A(idle 触发独立 run,是 run 起点非注入)顶层显示;
 * 待后端 refresh 激活通道 B(通知注入当前 run)后,再区分 A/B 通知让通道 B 进 injection 节点。
 */
const INJECTION_SOURCES = new Set(['running_session']);

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
    const map = {};
    for (const m of messages.value) {
      const source = m.metadata?.source;
      if (!source || !INJECTION_SOURCES.has(source)) continue;
      const runId = m.metadata?.run_id;
      if (!runId) continue;
      if (!map[runId]) map[runId] = [];
      map[runId].push(m);
    }
    // 每 run 内按 seq 排序(executionTreeBuilder 也会排一次,这里先排保证注入顺序稳定)
    for (const runId of Object.keys(map)) {
      map[runId].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    }
    return map;
  });

  const visibleMessages = computed(() => {
    const list = messages.value;
    if (!list.length) return [];

    // 注入吸收判定:注入消息的 run_id 对应的 assistant 在列表里 → 被 executionTree 吸收,顶层不渲染。
    // 兜底:run_id 缺失 / 对应 assistant 不在(run 结束后才到的迟到通知)→ 不吸收,顶层显示。
    const assistantRunIds = new Set();
    for (const m of list) {
      if (m.role === 'assistant') {
        const rid = m.run_id || m.metadata?.run_id;
        if (rid) assistantRunIds.add(rid);
      }
    }
    const isAbsorbedInjection = (m) => {
      const source = m.metadata?.source;
      if (!source || !INJECTION_SOURCES.has(source)) return false;
      const rid = m.metadata?.run_id;
      return Boolean(rid && assistantRunIds.has(rid));
    };

    const filtered = list.filter((m) => !isAbsorbedInjection(m));

    // compression 摘要折叠(对注入过滤后的列表)
    const withSeq = filtered.filter((message) => message.seq != null);
    const summaryMsg = withSeq
      .filter((message) => message.metadata?.msg_type === 'context_compression_summary')
      .sort((a, b) => b.seq - a.seq)[0];

    if (!summaryMsg) return filtered;

    const replacesUpTo = summaryMsg.metadata?.replaces_up_to_seq;
    const cutoff = replacesUpTo != null ? replacesUpTo : summaryMsg.seq;
    const rest = filtered.filter((message) => (
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
