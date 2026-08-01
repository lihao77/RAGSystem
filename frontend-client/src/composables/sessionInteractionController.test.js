import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionInteractionController } from './sessionInteractionController.js';

const runtimeWith = (...interactionIds) => ({
  allowed_actions: ['respond_interaction'],
  pending_interactions: interactionIds.map(interaction_id => ({ interaction_id })),
});

test('SessionInteractionController delegates validated directional payloads to chat-sdk', async () => {
  const calls = [];
  const controller = createSessionInteractionController({
    getSessionRuntime: () => runtimeWith('call-1'),
    respondViaSdk: async (...args) => calls.push(args),
  });

  await controller.respond('call-1', { kind: 'approval', approved: true, message: 'ok' });
  assert.deepEqual(calls, [['call-1', { kind: 'approval', approved: true, message: 'ok' }]]);
});

test('SessionInteractionController exposes no frontend-owned ACK state', () => {
  const controller = createSessionInteractionController({
    getSessionRuntime: () => runtimeWith('call-2'),
    respondViaSdk: async () => {},
  });

  assert.equal(controller.hasPending('call-2'), false);
  assert.equal(controller.resolve('call-2'), false);
  assert.equal(controller.reject('call-2'), false);
  assert.doesNotThrow(() => controller.reset());
});

test('SessionInteractionController rejects remote-owned or stale interactions before SDK transport', async () => {
  let sent = 0;
  let runtime = { allowed_actions: [], pending_interactions: [{ interaction_id: 'call-3' }] };
  const controller = createSessionInteractionController({
    getSessionRuntime: () => runtime,
    respondViaSdk: async () => { sent += 1; },
  });

  await assert.rejects(
    controller.respond('call-3', { kind: 'approval', approved: true }),
    /不允许响应交互/,
  );
  runtime = runtimeWith('call-4');
  await assert.rejects(
    controller.respond('call-3', { kind: 'approval', approved: true }),
    /交互请求已失效/,
  );
  assert.equal(sent, 0);
});
