import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

import { useLlmStore } from './llm.js';
import { setActiveSessionId, setSelectionChangeListener } from './sessionScope.js';

function setup() {
  localStorage.clear();
  setActivePinia(createPinia());
  setActiveSessionId('');
}

test('无会话覆盖层时 selectedLLM 读个人默认（localStorage）', () => {
  setup();
  localStorage.setItem('selectedLLMModel', 'p1|openai|m1');
  const store = useLlmStore();
  assert.equal(store.selectedLLM, 'p1|openai|m1');
});

test('会话覆盖层仅对激活会话生效，切走/新建即回落个人默认', () => {
  setup();
  localStorage.setItem('selectedLLMModel', 'default-model');
  const store = useLlmStore();

  setActiveSessionId('session-a');
  store.applySessionOverride('session-a', 'p1|openai|m1');
  assert.equal(store.selectedLLM, 'p1|openai|m1');

  setActiveSessionId('session-b');
  assert.equal(store.selectedLLM, 'default-model');

  setActiveSessionId('');
  assert.equal(store.selectedLLM, 'default-model');
});

test('手动选择清掉当前会话覆盖并更新个人默认，不影响其它会话已存的覆盖值语义', () => {
  setup();
  localStorage.setItem('selectedLLMModel', 'default-model');
  const store = useLlmStore();

  setActiveSessionId('session-a');
  store.applySessionOverride('session-a', 'p1|openai|m1');
  store.setSelectedLLM('p2|openai|m2');
  assert.equal(store.selectedLLM, 'p2|openai|m2');
  assert.equal(localStorage.getItem('selectedLLMModel'), 'p2|openai|m2');
});

test('clearSessionOverride 只清目标会话的覆盖（缺省 = 激活会话）', () => {
  setup();
  const store = useLlmStore();
  setActiveSessionId('session-a');
  store.applySessionOverride('session-a', 'p1|openai|m1');

  store.clearSessionOverride('session-b');
  assert.equal(store.selectedLLM, 'p1|openai|m1');

  store.clearSessionOverride();
  assert.equal(store.selectedLLM, '');
});

test('恢复记录为空串（该会话上次发送未覆盖模型）也会覆盖默认显示为"默认"', () => {
  setup();
  localStorage.setItem('selectedLLMModel', 'default-model');
  const store = useLlmStore();
  setActiveSessionId('session-a');
  store.applySessionOverride('session-a', '');
  assert.equal(store.selectedLLM, '');
});

test('主动选择触发选择变更通知，恢复与清覆盖不触发', () => {
  setup();
  const calls = [];
  setSelectionChangeListener(() => calls.push('notify'));
  const store = useLlmStore();

  store.applySessionOverride('session-a', 'p1|openai|m1');
  store.clearSessionOverride('session-a');
  assert.equal(calls.length, 0);

  store.setSelectedLLM('p2|openai|m2');
  assert.equal(calls.length, 1);

  setSelectionChangeListener(null);
});
