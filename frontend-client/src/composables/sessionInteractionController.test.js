import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionInteractionController } from './sessionInteractionController.js';

const runtimeWith = (...interactionIds) => ({
  allowed_actions: ['respond_interaction'],
  pending_interactions: interactionIds.map(interaction_id => ({ interaction_id })),
});

test('SessionInteractionController waits for WS ack and preserves directional payloads', async () => {
  const sent = [];
  const controller = createSessionInteractionController({
    getCurrentSessionId: () => 'session-1',
    getSocket: () => ({ readyState: 1, send: data => sent.push(JSON.parse(data)) }),
    getSessionRuntime: () => runtimeWith('call-1'),
    respondHttp: async () => assert.fail('HTTP fallback should not run'),
  });

  const response = controller.respond('call-1', { kind: 'approval', approved: true, message: 'ok' });
  assert.deepEqual(sent[0], {
    type: 'interaction',
    session_id: 'session-1',
    call_id: 'call-1',
    payload: { kind: 'approval', phase: 'responded', approved: true, message: 'ok' },
  });
  assert.equal(controller.hasPending('call-1'), true);
  assert.equal(controller.resolve('call-1'), true);
  await response;
});

test('SessionInteractionController rejects negative ack without HTTP fallback', async () => {
  let httpCalls = 0;
  const controller = createSessionInteractionController({
    getCurrentSessionId: () => 'session-1',
    getSocket: () => ({ readyState: 1, send: () => {} }),
    getSessionRuntime: () => runtimeWith('call-2'),
    respondHttp: async () => { httpCalls += 1; },
  });

  const response = controller.respond('call-2', { kind: 'user_input', value: 'answer' });
  controller.reject('call-2', 'not found');
  await assert.rejects(response, error => error.code === 'INTERACTION_REJECTED');
  assert.equal(httpCalls, 0);
});

test('SessionInteractionController falls back to HTTP when WS send fails', async () => {
  const calls = [];
  const controller = createSessionInteractionController({
    getCurrentSessionId: () => 'session-1',
    getSocket: () => ({ readyState: 1, send: () => { throw new Error('offline'); } }),
    getSessionRuntime: () => runtimeWith('call-3'),
    respondHttp: async (...args) => calls.push(args),
  });

  await controller.respond('call-3', { kind: 'user_input', value: 'answer' });
  assert.deepEqual(calls, [['session-1', 'call-3', { kind: 'user_input', value: 'answer' }]]);
});

test('SessionInteractionController rejects remote-owned or stale interactions before transport', async () => {
  let sent = 0;
  let runtime = { allowed_actions: [], pending_interactions: [{ interaction_id: 'call-4' }] };
  const controller = createSessionInteractionController({
    getCurrentSessionId: () => 'session-1',
    getSocket: () => ({ readyState: 1, send: () => { sent += 1; } }),
    getSessionRuntime: () => runtime,
    respondHttp: async () => { sent += 1; },
  });

  await assert.rejects(
    controller.respond('call-4', { kind: 'approval', approved: true }),
    /不允许响应交互/,
  );
  runtime = runtimeWith('call-5');
  await assert.rejects(
    controller.respond('call-4', { kind: 'approval', approved: true }),
    /交互请求已失效/,
  );
  assert.equal(sent, 0);
});
