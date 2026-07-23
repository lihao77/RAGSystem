import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getProviderTestTargets,
  providerTestTaskLabel,
  summarizeProviderTestResult,
} from './providerTestTargets.js';

test('exposes each configured provider task instead of choosing one implicitly', () => {
  const targets = getProviderTestTargets({
    model_map: {
      chat: 'chat-model',
      embedding: ['embed-model', 'embed-backup'],
      rerank: 'rerank-model',
    },
  });
  assert.deepEqual(targets.map(({ task, model }) => ({ task, model })), [
    { task: 'chat', model: 'chat-model' },
    { task: 'embedding', model: 'embed-model' },
    { task: 'rerank', model: 'rerank-model' },
  ]);
  assert.equal(providerTestTaskLabel('embedding'), 'Embedding');
});

test('validates embedding vector shape', () => {
  assert.equal(
    summarizeProviderTestResult(
      { task: 'embedding' },
      { embeddings: [[0.1, 0.2, 0.3]], latency: 0.125 },
    ),
    '返回 3 维向量 · 0.13s',
  );
  assert.throws(
    () => summarizeProviderTestResult({ task: 'embedding' }, { embeddings: [[]] }),
    /未返回有效向量/,
  );
});

test('checks rerank relevance instead of only counting results', () => {
  const target = { task: 'rerank' };
  assert.match(
    summarizeProviderTestResult(target, {
      results: [
        { id: 'rerank-relevant', score: 0.91 },
        { id: 'rerank-unrelated', score: 0.08 },
      ],
    }),
    /排序正确/,
  );
  assert.throws(
    () => summarizeProviderTestResult(target, {
      results: [
        { id: 'rerank-relevant', score: 0.1 },
        { id: 'rerank-unrelated', score: 0.8 },
      ],
    }),
    /未高于无关文档/,
  );
});
