import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLiveParticipant,
  orderParticipants,
  participantAccentVar,
  participantMeta,
  participantName,
  participantStatus,
  participantStatusText,
  statusLabel,
  statusToneColor,
} from './participantVisual.js';

const root = { participant_id: 'root', scope: 'root', display_name: '主智能体', lifecycle_status: 'active' };
const worker = { participant_id: 'child-1', scope: 'child', agent_name: 'worker', last_run_status: 'running' };

test('root 排在最前，其余保持服务端顺序', () => {
  const ordered = orderParticipants([
    { participant_id: 'child-2', scope: 'child' },
    root,
    { participant_id: 'child-1', scope: 'child' },
  ]);
  assert.deepEqual(ordered.map(item => item.participant_id), ['root', 'child-2', 'child-1']);
  // 没有 root 条目时原样返回，且丢掉没有 id 的脏数据。
  assert.deepEqual(
    orderParticipants([{ participant_id: 'child-1', scope: 'child' }, { scope: 'child' }]).map(item => item.participant_id),
    ['child-1'],
  );
});

test('名称与副标题回落到 agent_name / 身份默认值', () => {
  assert.equal(participantName(root), '主智能体');
  assert.equal(participantName(worker), 'worker');
  assert.equal(participantName({ participant_id: 'child-9', scope: 'child' }), '智能体');
  assert.equal(participantName(null), '');
  assert.equal(participantMeta(root), '主智能体');
  assert.equal(participantMeta({ participant_id: 'child-9', scope: 'child' }), '子智能体');
  assert.equal(participantMeta(worker), 'worker');
});

test('运行态只亮脉冲点，异常态才写字', () => {
  assert.equal(participantStatus(worker), 'running');
  assert.equal(isLiveParticipant(worker), true);
  assert.equal(participantStatusText(worker), '');
  assert.equal(isLiveParticipant({ participant_id: 'child-2', scope: 'child', last_run_status: 'failed' }), false);
  assert.equal(participantStatusText({ participant_id: 'child-2', scope: 'child', last_run_status: 'failed' }), '失败');
  // Run 级状态优先于生命周期：一次失败不能被"仍在活动"盖掉。
  assert.equal(participantStatus({ lifecycle_status: 'active', last_run_status: 'interrupted' }), 'interrupted');
});

test('配色与状态标签沿用同一份映射', () => {
  assert.equal(participantAccentVar(root), '--color-brand-accent');
  assert.match(participantAccentVar(worker), /^--color-agent-/);
  // 同一 participant 在任何位置都同色。
  assert.equal(participantAccentVar(worker), participantAccentVar({ participant_id: 'child-1', scope: 'child' }));
  assert.equal(statusLabel('interrupted'), '已中断');
  assert.equal(statusToneColor('failed'), 'var(--color-error)');
  assert.equal(statusToneColor(undefined), 'var(--color-text-muted)');
});
