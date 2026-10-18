import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import MockAdapter from 'axios-mock-adapter';
import { httpClient } from './http.js';
import { defaultLlmRevision, fetchDefaultLlm, invalidateDefaultLlm } from './runtimeCore.js';
import { createProvider, updateProvider, reorderProviders, deleteProvider } from './modelAdapter.js';
import { createTeam, activateTeam, deleteTeam, renameTeam, copyAgentsToTeam,
  updateAgentConfig, deleteAgent, createAgent } from './agentConfig.js';
import { updateSystemConfig, reloadSystemConfig } from './systemConfig.js';
import { publishAgentDraft } from './agentBuilder.js';

const mock = new MockAdapter(httpClient);
const endpoint = '/api/agent/runtime-core/status';
const readiness = (model = 'system-model', extra = {}) => ({ data: { llm: {
  provider: 'demo', provider_type: 'openai', model_name: model,
  source: 'system_config.llm', fallback_reason: null, ...extra,
} } });
beforeEach(() => { mock.reset(); invalidateDefaultLlm(); });
after(() => mock.restore());

test('保留实际模型、来源和失效回落原因，同时合并并发请求', async () => {
  mock.onGet(`${endpoint}?team_name=team&agent_name=agent`).reply(200,
    readiness('fallback', { fallback_reason: 'agent_default_tier_unresolved' }));
  const [first, second] = await Promise.all([fetchDefaultLlm(' team ', ' agent '), fetchDefaultLlm('team', 'agent')]);
  assert.deepEqual(first, { provider: 'demo', provider_type: 'openai', model: 'fallback',
    source: 'system_config.llm', fallback_reason: 'agent_default_tier_unresolved' });
  assert.deepEqual(first, second);
  await fetchDefaultLlm('team', 'agent');
  assert.equal(mock.history.get.length, 1);
});

test('模型已缺失时不把残留引用当作可用默认模型，也不缓存失败', async () => {
  mock.onGet(endpoint).replyOnce(200, readiness('removed', { source: 'missing' }));
  mock.onGet(endpoint).replyOnce(500, {});
  mock.onGet(endpoint).reply(200, readiness());
  assert.equal(await fetchDefaultLlm(''), null);
  assert.equal(await fetchDefaultLlm(''), null);
  assert.equal((await fetchDefaultLlm('')).model, 'system-model');
  assert.equal(mock.history.get.length, 3);
});

test('短期缓存到期后重新解析，覆盖其他窗口的配置更新', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  mock.onGet(endpoint).reply(200, readiness());
  await fetchDefaultLlm('');
  now += 30_001;
  mock.onGet(endpoint).reply(200, readiness('new-model'));
  assert.equal((await fetchDefaultLlm('')).model, 'new-model');
  assert.equal(mock.history.get.length, 2);
});

test('失效前的成功或失败响应不能覆盖或删除新缓存', async () => {
  for (const status of [200, 500]) {
    mock.resetHandlers();
    invalidateDefaultLlm();
    let finishOld;
    mock.onGet(endpoint).replyOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const old = fetchDefaultLlm('');
    await new Promise(resolve => setImmediate(resolve));
    invalidateDefaultLlm();
    mock.onGet(endpoint).reply(200, readiness('new-model'));
    assert.equal((await fetchDefaultLlm('')).model, 'new-model');
    finishOld([status, readiness('old-model')]);
    assert.equal((await old).model, 'new-model');
    const count = mock.history.get.length;
    assert.equal((await fetchDefaultLlm('')).model, 'new-model');
    assert.equal(mock.history.get.length, count);
  }
});

test('模型、Agent、团队、系统配置及草稿发布成功后刷新默认模型缓存', async () => {
  const mutations = [
    () => createProvider({}), () => updateProvider('demo', {}), () => reorderProviders(['demo']), () => deleteProvider('demo'),
    () => createTeam({}), () => activateTeam('team'), () => deleteTeam('team'), () => renameTeam('team', 'new'),
    () => copyAgentsToTeam('team', 'source', ['agent']), () => updateAgentConfig('agent', {}, 'team'),
    () => deleteAgent('agent', 'team'), () => createAgent({}, 'team'),
    () => updateSystemConfig({}), () => reloadSystemConfig(), () => publishAgentDraft('draft', 1),
  ];
  mock.onGet(endpoint).reply(200, readiness());
  mock.onAny().reply(200, { data: {} });
  for (const mutate of mutations) {
    await fetchDefaultLlm('');
    const count = mock.history.get.length;
    const revision = defaultLlmRevision.value;
    await mutate();
    assert.equal(defaultLlmRevision.value, revision + 1);
    await fetchDefaultLlm('');
    assert.equal(mock.history.get.length, count + 1);
  }
});

test('保存失败保留当前默认模型缓存', async () => {
  mock.onGet(endpoint).reply(200, readiness());
  await fetchDefaultLlm('');
  const revision = defaultLlmRevision.value;
  mock.onPut('/api/model-adapter/providers/demo').reply(400, { message: '保存失败' });
  await assert.rejects(updateProvider('demo', {}), /保存失败/);
  assert.equal(defaultLlmRevision.value, revision);
  await fetchDefaultLlm('');
  assert.equal(mock.history.get.length, 1);
});
