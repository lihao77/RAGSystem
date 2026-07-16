import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionInteractionController } from './sessionInteractionController.js';

test('SessionInteractionController waits for WS ack and preserves directional payloads', async () => {
  const sent = [];
  const controller = createSessionInteractionController({
    getCurrentSessionId: () => 'session-1',
    getSocket: () => ({ readyState: 1, send: data => sent.push(JSON.parse(data)) }),
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

test('SessionInteractionController rejects negative ack without HTTP fallback and deduplicates required events', async () => {
  let httpCalls = 0;
  const controller = createSessionInteractionController({
    getCurrentSessionId: () => 'session-1',
    getSocket: () => ({ readyState: 1, send: () => {} }),
    respondHttp: async () => { httpCalls += 1; },
  });

  const response = controller.respond('call-2', { kind: 'user_input', value: 'answer' });
  controller.reject('call-2', 'not found');
  await assert.rejects(response, error => error.code === 'INTERACTION_REJECTED');
  assert.equal(httpCalls, 0);
  assert.equal(controller.rememberRequired('approval', 'call-2'), true);
  assert.equal(controller.rememberRequired('approval', 'call-2'), false);
  controller.reset();
  assert.equal(controller.rememberRequired('approval', 'call-2'), true);
});

test('SessionInteractionController falls back to HTTP when WS send fails', async () => {
  const calls = [];
  const controller = createSessionInteractionController({
    getCurrentSessionId: () => 'session-1',
    getSocket: () => ({ readyState: 1, send: () => { throw new Error('offline'); } }),
    respondHttp: async (...args) => calls.push(args),
  });

  await controller.respond('call-3', { kind: 'user_input', value: 'answer' });
  assert.deepEqual(calls, [['session-1', 'call-3', { kind: 'user_input', value: 'answer' }]]);
});
