import test from 'node:test';
import assert from 'node:assert/strict';
import MockAdapter from 'axios-mock-adapter';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

import { httpClient } from '../api/http.js';
import {
  backgroundTaskCancelReason,
  useSessionBackgroundTasks,
} from './useSessionBackgroundTasks.js';

function withMock(setup, run) {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve().then(run).finally(() => mock.restore());
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('background task state filters running tasks and only selects cancel_available tasks', async () => {
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session-1/background-tasks').reply(200, { data: { tasks: [
      { task_id: 'running-cancellable', status: 'running', cancel_available: true },
      { task_id: 'running-remote', status: 'running', cancel_available: false, cancel_unavailable_reason: 'not_owned' },
      { task_id: 'done', status: 'completed', cancel_available: false },
    ] } });
  }, async () => {
    const state = useSessionBackgroundTasks(ref('session-1'));
    await state.loadTasks();

    assert.equal(state.runningCount.value, 2);
    assert.deepEqual(state.filteredTasks.value.map((task) => task.task_id), ['running-cancellable', 'running-remote']);
    state.toggleTaskSelection(state.tasks.value[0]);
    state.toggleTaskSelection(state.tasks.value[1]);
    assert.deepEqual(state.selectedTaskIds.value, ['running-cancellable']);
    assert.equal(backgroundTaskCancelReason(state.tasks.value[1]), '任务由其他运行实例持有，当前实例无法取消');
    assert.equal(backgroundTaskCancelReason({ status: 'completed', cancel_available: false, cancel_unavailable_reason: 'already_finished' }), '任务已结束');
  });
});

test('background lifecycle events merge immediately without another request', async () => {
  let requests = 0;
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session-1/background-tasks').reply(() => {
      requests += 1;
      return [200, { data: { tasks: [{ task_id: 'task-1', status: requests > 1 ? 'completed' : 'running', cancel_available: requests === 1 }] } }];
    });
  }, async () => {
    const state = useSessionBackgroundTasks(ref('session-1'));
    await state.loadTasks();
    const requestsBeforeEvent = requests;
    const handled = state.handleLifecycleEvent({
      entity: 'background_task',
      action: 'completed',
      task: { task_id: 'task-1', status: 'completed', cancel_available: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(handled, true);
    assert.equal(state.tasks.value[0].status, 'completed');
    assert.equal(requests, requestsBeforeEvent);
  });
});

test('batch cancel uses only selected cancel_available tasks', async () => {
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session-1/background-tasks').reply(200, { data: { tasks: [
      { task_id: 'a', status: 'running', cancel_available: true },
      { task_id: 'b', status: 'running', cancel_available: false },
    ] } });
    mock.onPost('/api/agent/sessions/session-1/background-tasks/cancel', { task_ids: ['a'] }).reply(200, {
      data: { results: [{ task_id: 'a', status: 'cancelled', cancel_available: false }] },
    });
  }, async () => {
    const state = useSessionBackgroundTasks(ref('session-1'));
    await state.loadTasks();
    state.toggleTaskSelection(state.tasks.value.find((task) => task.task_id === 'a'));
    const results = await state.cancelSelected();

    assert.deepEqual(results.map((item) => item.task_id), ['a']);
    assert.deepEqual(state.selectedTaskIds.value, []);
    assert.deepEqual(state.tasks.value.find((task) => task.task_id === 'a'), {
      task_id: 'a',
      status: 'cancelled',
      cancel_available: false,
      cancel_unavailable_reason: 'already_finished',
    });
  });
});

test('a late cancel response cannot mutate the newly selected session', async () => {
  const cancelResponse = deferred();
  await withMock((mock) => {
    mock.onGet('/api/agent/sessions/session-1/background-tasks').reply(200, { data: { tasks: [
      { task_id: 'old-task', status: 'running', cancel_available: true },
    ] } });
    mock.onGet('/api/agent/sessions/session-2/background-tasks').reply(200, { data: { tasks: [
      { task_id: 'new-task', status: 'running', cancel_available: true },
    ] } });
    mock.onPost('/api/agent/sessions/session-1/background-tasks/old-task/cancel').reply(() => cancelResponse.promise);
  }, async () => {
    const sessionId = ref('session-1');
    const state = useSessionBackgroundTasks(sessionId);
    await state.loadTasks();
    const pendingCancel = state.cancelTask(state.tasks.value.find((task) => task.task_id === 'old-task'));

    sessionId.value = 'session-2';
    await new Promise((resolve) => setTimeout(resolve, 0));
    await state.loadTasks();
    cancelResponse.resolve([200, { data: { result: { task_id: 'old-task', status: 'cancelled' } } }]);
    await pendingCancel;

    assert.deepEqual(state.tasks.value.map((task) => task.task_id), ['new-task']);
    assert.equal(state.error.value, '');
  });
});
