import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

import { useThinkingStore } from './thinking.js';
import { setActiveSessionId } from './sessionScope.js';

function setup() {
  localStorage.clear();
  setActivePinia(createPinia());
  setActiveSessionId('');
}

test('无会话覆盖层时 thinkingLevel 读个人默认，空串表示跟随', () => {
  setup();
  localStorage.setItem('thinkingLevel', 'high');
  const store = useThinkingStore();
  assert.equal(store.thinkingLevel, 'high');
  assert.equal(store.isOverride, true);
});

test('非法档位不落库：set 与 applySessionOverride 都收敛', () => {
  setup();
  const store = useThinkingStore();
  store.setThinkingLevel('ultra');
  assert.equal(store.thinkingLevel, '');

  store.applySessionOverride('session-a', 'extreme');
  assert.equal(store.thinkingLevel, '');
});

test('会话覆盖层仅对激活会话生效，切走即回落个人默认', () => {
  setup();
  localStorage.setItem('thinkingLevel', 'low');
  const store = useThinkingStore();

  setActiveSessionId('session-a');
  store.applySessionOverride('session-a', 'max');
  assert.equal(store.thinkingLevel, 'max');

  setActiveSessionId('');
  assert.equal(store.thinkingLevel, 'low');
  assert.equal(localStorage.getItem('thinkingLevel'), 'low');
});

test('手动选择清掉当前会话覆盖并更新个人默认', () => {
  setup();
  localStorage.setItem('thinkingLevel', 'low');
  const store = useThinkingStore();

  setActiveSessionId('session-a');
  store.applySessionOverride('session-a', 'max');
  store.setThinkingLevel('medium');
  assert.equal(store.thinkingLevel, 'medium');
  assert.equal(localStorage.getItem('thinkingLevel'), 'medium');
});
