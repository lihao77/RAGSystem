import test from 'node:test';
import assert from 'node:assert/strict';
import MockAdapter from 'axios-mock-adapter';
import { nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

import { httpClient } from '../api/http.js';
import { useSessionGoal } from './useSessionGoal.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function withMock(setup, run) {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve()
    .then(run)
    .finally(() => mock.restore());
}

test('Goal events reveal a new Goal during a run and supersede a slow initial query', async () => {
  const initial = deferred();
  let requests = 0;
  let current = { id: 'goal-new', status: 'active', progress: { done: 0 } };
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session-1/goals/current').reply(() => {
      requests += 1;
      return requests === 1 ? initial.promise : [200, { goal: current }];
    });
  }, async () => {
    const state = useSessionGoal(ref('session-1'));
    assert.equal(state.loading.value, true);
    assert.equal(state.handleLifecycleEvent({ entity: 'background_task' }), false);
    assert.equal(state.handleLifecycleEvent({ entity: 'goal' }), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(state.goal.value.id, 'goal-new');
    assert.equal(state.loading.value, false);
    initial.resolve([200, { goal: null }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(state.goal.value.id, 'goal-new');
    current = { ...current, status: 'completed', progress: { done: 1 } };
    state.handleLifecycleEvent({ entity: 'goal' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(state.goal.value.status, 'completed');
    assert.equal(state.goal.value.progress.done, 1);
  });
});

test('a lifecycle refresh during pause clears pending action and rejects its older response', async () => {
  const pause = deferred();
  let current = { id: 'goal-1', status: 'active' };
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session-1/goals/current').reply(() => [200, { goal: current }]);
    mock.onPost('/api/agent/sessions/session-1/goals/current/pause').reply(() => pause.promise);
  }, async () => {
    const state = useSessionGoal(ref('session-1'));
    await state.loadGoal();
    const pending = state.pauseGoal();
    assert.equal(state.pendingAction.value, 'pause');
    current = { id: 'goal-1', status: 'completed' };
    state.handleLifecycleEvent({ entity: 'goal' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    pause.resolve([200, { goal: { id: 'goal-1', status: 'paused' } }]);
    await pending;
    assert.equal(state.goal.value.status, 'completed');
    assert.equal(state.pendingAction.value, null);
  });
});

test('useSessionGoal exposes pause for active goals and start for paused goals', async () => {
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session-1/goals/current').reply(200, {
      goal: { id: 'goal-1', objective: '完成检索模块', status: 'active' },
    });
    mock.onPost('/api/agent/sessions/session-1/goals/current/pause').reply(200, {
      goal: { id: 'goal-1', objective: '完成检索模块', status: 'paused' },
    });
    mock.onPost('/api/agent/sessions/session-1/goals/current/start').reply(200, {
      goal: { id: 'goal-1', objective: '完成检索模块', status: 'active' },
    });
  }, async () => {
    const state = useSessionGoal(ref('session-1'));
    await state.loadGoal();

    assert.equal(state.goal.value.status, 'active');
    assert.equal(state.canPause.value, true);
    assert.equal(state.canStart.value, false);

    await state.pauseGoal();
    assert.equal(state.goal.value.status, 'paused');
    assert.equal(state.canPause.value, false);
    assert.equal(state.canStart.value, true);

    await state.startGoal();
    assert.equal(state.goal.value.status, 'active');
    assert.equal(state.canPause.value, true);
  });
});

test('useSessionGoal ignores a response from the previously selected session', async () => {
  const firstRequest = deferred();
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session-1/goals/current').reply(() => firstRequest.promise);
    mock.onGet('/api/agent/sessions/session-2/goals/current').reply(200, {
      goal: { id: 'goal-2', status: 'paused' },
    });
  }, async () => {
    const sessionId = ref('session-1');
    const state = useSessionGoal(sessionId);
    sessionId.value = 'session-2';
    await nextTick();
    await state.loadGoal();

    firstRequest.resolve([200, { goal: { id: 'goal-1', status: 'active' } }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(state.goal.value.id, 'goal-2');
    assert.equal(state.goal.value.status, 'paused');
  });
});

test('useSessionGoal keeps the current goal and exposes API errors', async () => {
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session-1/goals/current').reply(200, {
      goal: { id: 'goal-1', status: 'active' },
    });
    mock.onPost('/api/agent/sessions/session-1/goals/current/pause').reply(409, {
      message: 'Goal 当前无法暂停',
    });
  }, async () => {
    const state = useSessionGoal(ref('session-1'));
    await state.loadGoal();
    await state.pauseGoal();

    assert.equal(state.goal.value.status, 'active');
    assert.equal(state.error.value, 'Goal 当前无法暂停');
    assert.equal(state.pendingAction.value, null);
  });
});

