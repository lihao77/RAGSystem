import test from 'node:test';
import assert from 'node:assert/strict';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import { httpClient } from './http.js';
import {
  cancelSessionBackgroundTask,
  cancelSessionBackgroundTasks,
  getSessionBackgroundTasks,
} from './backgroundTasks.js';

function withMock(setup, run) {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve().then(run).finally(() => mock.restore());
}

test('background task API lists and cancels one encoded task id', async () => {
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session%2Fone/background-tasks').reply(200, {
      data: { tasks: [{ task_id: 'task/1', status: 'running' }] },
    });
    mock.onPost('/api/agent/sessions/session%2Fone/background-tasks/task%2F1/cancel').reply(200, {
      data: { result: { task_id: 'task/1', status: 'cancelled' } },
    });
  }, async () => {
    const listed = await getSessionBackgroundTasks('session/one');
    const cancelled = await cancelSessionBackgroundTask('session/one', 'task/1');

    assert.equal(listed.data.tasks[0].task_id, 'task/1');
    assert.equal(cancelled.data.result.status, 'cancelled');
  });
});

test('background task API sends selected ids to the batch cancel endpoint', async () => {
  await withMock((mock) => {
    mock.onPost('/api/agent/sessions/session-1/background-tasks/cancel', { task_ids: ['a', 'b'] }).reply(200, {
      data: { results: [{ task_id: 'a' }, { task_id: 'b' }] },
    });
  }, async () => {
    const result = await cancelSessionBackgroundTasks('session-1', ['a', 'b']);
    assert.deepEqual(result.data.results.map((item) => item.task_id), ['a', 'b']);
  });
});

