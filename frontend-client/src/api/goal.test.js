import test from 'node:test';
import assert from 'node:assert/strict';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import { httpClient } from './http.js';
import {
  getCurrentGoal,
  listGoals,
  pauseCurrentGoal,
  startCurrentGoal,
} from './goal.js';

function withMock(setup, run) {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve()
    .then(run)
    .finally(() => mock.restore());
}

test('Goal API encodes the session id and reads current/list endpoints', async () => {
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session%2Fone/goals/current').reply(200, {
      goal: { id: 'goal-1', status: 'active' },
    });
    mock.onGet('/api/agent/sessions/session%2Fone/goals').reply(200, {
      goals: [{ id: 'goal-1', status: 'active' }],
    });
  }, async () => {
    const current = await getCurrentGoal('session/one');
    const listed = await listGoals('session/one');

    assert.equal(current.goal.id, 'goal-1');
    assert.deepEqual(listed.goals.map((goal) => goal.id), ['goal-1']);
  });
});

test('Goal API uses empty-body POST requests for start and pause controls', async () => {
  await withMock((mock) => {
    mock.onPost('/api/agent/sessions/session-1/goals/current/start').reply((config) => {
      assert.equal(config.data, undefined);
      return [200, { goal: { id: 'goal-1', status: 'active' } }];
    });
    mock.onPost('/api/agent/sessions/session-1/goals/current/pause').reply((config) => {
      assert.equal(config.data, undefined);
      return [200, { goal: { id: 'goal-1', status: 'paused' } }];
    });
  }, async () => {
    const started = await startCurrentGoal('session-1');
    const paused = await pauseCurrentGoal('session-1');

    assert.equal(started.goal.status, 'active');
    assert.equal(paused.goal.status, 'paused');
  });
});

