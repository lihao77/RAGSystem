import assert from 'node:assert/strict';
import test from 'node:test';

import { hasKnowledgeRetrievalSource, parseKnowledgeSearchFilters } from './knowledgeSearch.js';

test('empty knowledge filters are omitted', () => {
  assert.equal(parseKnowledgeSearchFilters('  '), undefined);
});

test('knowledge filters accept nested JSON objects', () => {
  assert.deepEqual(parseKnowledgeSearchFilters('{"category":"guide","tags":["rag"]}'), {
    category: 'guide',
    tags: ['rag'],
  });
});

test('knowledge filters reject invalid JSON and non-object values', () => {
  assert.throws(() => parseKnowledgeSearchFilters('{bad'), /有效的 JSON 对象/);
  assert.throws(() => parseKnowledgeSearchFilters('["rag"]'), /必须是 JSON 对象/);
  assert.throws(() => parseKnowledgeSearchFilters('null'), /必须是 JSON 对象/);
});

test('knowledge retrieval source distinguishes absent score branches', () => {
  const keywordOnly = { retrieval_sources: ['keyword'], vector_score: null, keyword_score: 0.8 };
  assert.equal(hasKnowledgeRetrievalSource(keywordOnly, 'keyword'), true);
  assert.equal(hasKnowledgeRetrievalSource(keywordOnly, 'vector'), false);
  assert.equal(hasKnowledgeRetrievalSource({}, 'vector'), false);
});
