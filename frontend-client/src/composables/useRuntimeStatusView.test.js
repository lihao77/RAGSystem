import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useRuntimeStatusView } from './useRuntimeStatusView.js';

function buildView(sessionRuntimeSnapshot) {
  return useRuntimeStatusView({
    currentSessionId: ref('session-1'),
    messages: ref([]),
    isLoading: ref(false),
    activeRun: { active: false, phase: 'idle', runId: null, assistantMsgIndex: -1, runningToolCalls: {}, runningModelCalls: {} },
    llmRetryState: ref(null),
    formatRetryCountdown: () => '',
    sessionRuntime: ref(sessionRuntimeSnapshot),
    contextUsage: ref({ used: 0, max: 0 }),
  });
}

test('maintenance 状态按租约 kind 分流文案：compact 显示"正在压缩上下文…"', () => {
  // 刷新后瞬态横线/呼吸点都不在，这个胶囊是压缩进行时的唯一反馈。
  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  const compact = buildView({ state: 'maintenance', maintenance: { kind: 'compact', expires_at: futureExpiry } });
  assert.equal(compact.executionStatusText.value, '正在压缩上下文…');

  const rollback = buildView({ state: 'maintenance', maintenance: { kind: 'rollback', expires_at: futureExpiry } });
  assert.equal(rollback.executionStatusText.value, '会话维护中');

  // kind 缺失时保持通用文案（防御历史快照）。
  const unknown = buildView({ state: 'maintenance', maintenance: null });
  assert.equal(unknown.executionStatusText.value, '会话维护中');
});
