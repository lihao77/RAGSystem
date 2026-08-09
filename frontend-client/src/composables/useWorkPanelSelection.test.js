import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, reactive, ref } from 'vue';

import { createActiveRunState } from '../stores/session-run.js';
import { useWorkPanelSelection } from './useWorkPanelSelection.js';

function createMessage(id, overrides = {}) {
  return {
    id,
    role: 'assistant',
    finished: true,
    has_execution: true,
    executionTree: { root: null, steps: [] },
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
  runningMessage.executionTree = { root: { agentId: 'orchestrator_agent', callId: 'root', status: 'running', rounds: [{ round: 1, intent: 'active-step', intentComplete: false, toolCalls: [] }], children: [] }, steps: [] };
  messageRef.value = [...messageRef.value];
  await nextTick();

  assert.equal(state.selectedWorkPanelMessageKey.value, 'id:running');
  assert.equal(state.currentRunMessage.value.id, 'running');
});

test('selection ignores non-assistant messages', async () => {
  const { state } = createSelection([]);
  await state.selectWorkPanelMessage({ id: 'goal-user', role: 'user', has_execution: true });
  assert.equal(state.selectedWorkPanelMessageKey.value, '');
});

test('child participant ignores the root active run and loads its own execution', async () => {
  const oldChildMessage = createMessage('child-old', { run_id: 'child-old-run' });
  const latestChildMessage = createMessage('child-latest', { run_id: 'child-run' });
  const activeRun = reactive({
    ...createActiveRunState(),
    active: true,
    assistantMsgIndex: 0,
  });
  const selectedParticipantId = ref('child-1');
  const ensureCalls = [];
  const state = useWorkPanelSelection({
    messages: ref([oldChildMessage, latestChildMessage]),
    activeRun,
    selectedParticipantId,
    selectedParticipant: ref({ participant_id: 'child-1', last_run_id: 'child-run' }),
    hasExecutionContent: (msg) => Boolean(msg?.has_execution),
    ensureExecutionStepsLoaded: async (msg) => { ensureCalls.push(msg.id); },
    showToast: () => {},
  });
  await nextTick();

  assert.equal(state.currentRunMessage.value.id, 'child-latest');
  assert.deepEqual(ensureCalls, ['child-latest']);
});

test('child participant exposes a run anchor before its final message exists', async () => {
  const anchor = createMessage(null, {
    run_id: 'child-run',
    executionParticipantId: 'child-1',
    executionStepsLoaded: false,
  });
  const ensureCalls = [];
  const state = useWorkPanelSelection({
    messages: ref([]),
    activeRun: reactive({ ...createActiveRunState(), active: true, assistantMsgIndex: 4 }),
    selectedParticipantId: ref('child-1'),
    selectedParticipant: ref({ participant_id: 'child-1', last_run_id: 'child-run' }),
    getParticipantRunExecutionMessage: () => anchor,
    hasExecutionContent: (msg) => Boolean(msg?.has_execution),
    ensureExecutionStepsLoaded: async (msg) => { ensureCalls.push(msg.run_id); },
    showToast: () => {},
  });
  await nextTick();

  assert.equal(state.currentRunMessage.value, anchor);
  assert.equal(state.selectedWorkPanelMessageKey.value, 'participant:child-1:run:child-run');
  assert.deepEqual(ensureCalls, ['child-run']);
});
