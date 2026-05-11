import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, reactive, ref } from 'vue';

import { createActiveRunState } from './useActiveRunState.js';
import { useWorkPanelSelection } from './useWorkPanelSelection.js';

function createMessage(id, overrides = {}) {
  return {
    id,
    role: 'assistant',
    finished: true,
    has_execution: true,
    execution_steps: [{ round: 1, intent: `step-${id}` }],
    subtasks: [],
    ...overrides,
  };
}

function createSelection(messages, activeRunOverrides = {}) {
  const activeRun = reactive({
    ...createActiveRunState(),
    ...activeRunOverrides,
  });
  const ensureCalls = [];
  const state = useWorkPanelSelection({
    messages: ref(messages),
    activeRun,
    hasExecutionContent: (msg) => Boolean(msg?.has_execution),
    ensureExecutionStepsLoaded: async (msg) => { ensureCalls.push(msg.id); },
    showToast: () => {},
  });
  return { state, activeRun, messages: state.workPanelExecutionMessages, ensureCalls };
}

test('work panel follows active run until the user explicitly selects another execution', async () => {
  const oldMessage = createMessage('old');
  const runningMessage = createMessage('running', { finished: false });
  const { state, activeRun } = createSelection([oldMessage, runningMessage], {
    active: true,
    assistantMsgIndex: 1,
  });
  await nextTick();

  assert.equal(state.currentRunMessage.value.id, 'running');

  await state.selectWorkPanelMessage(oldMessage);
  await nextTick();

  assert.equal(state.selectedWorkPanelMessageKey.value, 'id:old');
  assert.equal(state.currentRunMessage.value.id, 'old');

  activeRun.active = false;
  await nextTick();

  assert.equal(state.currentRunMessage.value.id, 'old');
});

test('work panel auto-selects the active run when its execution data appears', async () => {
  const oldMessage = createMessage('old');
  const runningMessage = createMessage('running', {
    finished: false,
    has_execution: false,
    execution_steps: [],
  });
  const messageRef = ref([oldMessage, runningMessage]);
  const activeRun = reactive({
    ...createActiveRunState(),
    active: true,
    assistantMsgIndex: 1,
  });
  const state = useWorkPanelSelection({
    messages: messageRef,
    activeRun,
    hasExecutionContent: (msg) => Boolean(msg?.has_execution),
    ensureExecutionStepsLoaded: async () => {},
    showToast: () => {},
  });
  await nextTick();

  assert.equal(state.currentRunMessage.value.id, 'running');
  assert.equal(state.selectedWorkPanelMessageKey.value, '');

  runningMessage.has_execution = true;
  runningMessage.execution_steps = [{ round: 1, intent: 'active-step' }];
  messageRef.value = [...messageRef.value];
  await nextTick();

  assert.equal(state.selectedWorkPanelMessageKey.value, 'id:running');
  assert.equal(state.currentRunMessage.value.id, 'running');
});
