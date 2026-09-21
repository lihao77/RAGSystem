import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

import { useSessionRunStore, WORKBENCH_OVERVIEW_TAB } from './session-run.js';

const child = (participantId, overrides = {}) => ({
  participant_id: participantId,
  parent_participant_id: 'root',
  scope: 'child',
  agent_name: participantId,
  display_name: participantId,
  thread_key: `child:${participantId}`,
  lifecycle_status: 'active',
  last_run_id: null,
  last_run_status: 'running',
  ...overrides,
});

const rootParticipant = () => ({
  participant_id: 'root',
  parent_participant_id: null,
  scope: 'root',
  agent_name: null,
  display_name: '主智能体',
  thread_key: 'root',
  lifecycle_status: 'active',
  last_run_id: null,
  last_run_status: 'running',
});

test('主对话列永远是根会话：切换工作台页签不改变 messages', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.setParticipants([rootParticipant(), child('child-1'), child('child-2')]);
  store.setParticipantMessages('root', [{ role: 'user', id: 'root-1', content: '根会话' }]);
  store.setParticipantMessages('child-1', [{ role: 'user', id: 'child-1-task', content: '子任务' }]);

  assert.deepEqual(store.messages.map(message => message.id), ['root-1']);

  store.openWorkbenchParticipant('child-1');

  assert.deepEqual(store.messages.map(message => message.id), ['root-1']);
  assert.equal(store.selectedParticipantId, 'child-1');
  assert.deepEqual(store.workbenchThreadMessages.map(message => message.id), ['child-1-task']);
});

test('打开页签即展开工作台，root 落到概览页签', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.setParticipants([rootParticipant(), child('child-1')]);

  assert.equal(store.workbenchOpen, false);
  store.openWorkbenchParticipant('child-1');
  assert.equal(store.workbenchOpen, true);
  assert.equal(store.workbenchTab, 'child-1');
  assert.deepEqual(store.workbenchTabs, ['child-1']);
  assert.equal(store.selectedParticipantId, 'child-1');

  // 收起面板不动页签：再展开还是原来那条线程。
  store.closeWorkbench();
  assert.equal(store.workbenchOpen, false);
  store.openWorkbench();
  assert.equal(store.workbenchTab, 'child-1');

  // 根会话就在主对话列里，不该再占一个页签。
  store.openWorkbenchParticipant('root');
  assert.equal(store.workbenchTab, WORKBENCH_OVERVIEW_TAB);
  assert.equal(store.selectedParticipantId, 'root');
  assert.deepEqual(store.workbenchTabs, ['child-1']);
});

test('重复打开同一参与者不产生重复页签，关闭当前页签退回概览', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.setParticipants([rootParticipant(), child('child-1'), child('child-2')]);

  store.openWorkbenchParticipant('child-1');
  store.openWorkbenchParticipant('child-2');
  store.openWorkbenchParticipant('child-1');
  assert.deepEqual(store.workbenchTabs, ['child-1', 'child-2']);
  assert.equal(store.workbenchTab, 'child-1');

  // 关掉不是当前看的那个页签：视图不动。
  store.closeWorkbenchTab('child-2');
  assert.deepEqual(store.workbenchTabs, ['child-1']);
  assert.equal(store.workbenchTab, 'child-1');

  // 关掉正在看的页签：退回概览，面板本身不收起。
  store.closeWorkbenchTab('child-1');
  assert.equal(store.workbenchTab, WORKBENCH_OVERVIEW_TAB);
  assert.equal(store.selectedParticipantId, 'root');
  assert.equal(store.workbenchOpen, true);
});

test('参与者下线后它的页签与选中态一并收敛到概览', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.setParticipants([rootParticipant(), child('child-1')]);
  store.openWorkbenchParticipant('child-1');

  store.setParticipants([rootParticipant()]);

  assert.deepEqual(store.workbenchTabs, []);
  assert.equal(store.workbenchTab, WORKBENCH_OVERVIEW_TAB);
  assert.equal(store.selectedParticipantId, 'root');
});

test('会话级重置清空工作台，编辑态归属的根会话不受页签影响', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.setParticipants([rootParticipant(), child('child-1')]);
  store.openWorkbenchParticipant('child-1');
  store.setParticipantMessages('child-1', [{ role: 'user', id: 'child-1-task', content: '子任务' }]);

  store.resetSessionParticipants();

  assert.equal(store.workbenchOpen, false);
  assert.equal(store.workbenchTab, WORKBENCH_OVERVIEW_TAB);
  assert.deepEqual(store.workbenchTabs, []);
  assert.deepEqual(store.participantMessages, { root: [] });
});

test('子线程数据被清空时页签退回概览，不留空线程视图', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.setParticipants([rootParticipant(), child('child-1')]);
  store.openWorkbenchParticipant('child-1');
  store.setParticipantMessages('child-1', [{ role: 'user', id: 'child-1-task', content: '子任务' }]);
  store.setParticipantMessages('root', [{ role: 'user', id: 'root-1', content: '根会话' }]);

  store.clearChildParticipantMessages();

  assert.equal(store.workbenchTab, WORKBENCH_OVERVIEW_TAB);
  assert.deepEqual(store.workbenchTabs, []);
  assert.deepEqual(store.participantMessages.root.map(message => message.id), ['root-1']);
});
