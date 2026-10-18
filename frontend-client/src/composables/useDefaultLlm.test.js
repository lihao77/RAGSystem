import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref } from 'vue';
import MockAdapter from 'axios-mock-adapter';
import { httpClient } from '../api/http.js';
import { invalidateDefaultLlm } from '../api/runtimeCore.js';
import { useDefaultLlm } from './useDefaultLlm.js';

const mock = new MockAdapter(httpClient);
const endpoint = '/api/agent/runtime-core/status';
const readiness = model => ({ data: { llm: { provider: 'demo', model_name: model, source: 'agent_config.default' } } });
const scopes = [];
const create = (team, agent) => {
  const scope = effectScope();
  scopes.push(scope);
  return { scope, state: scope.run(() => useDefaultLlm(team, agent)) };
};
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };
beforeEach(() => { mock.reset(); invalidateDefaultLlm(); });
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); });
after(() => mock.restore());

test('快速切换团队时旧响应不会覆盖当前默认模型', async () => {
  let finishOld;
  mock.onGet(`${endpoint}?team_name=old`).reply(() => new Promise(resolve => { finishOld = resolve; }));
  mock.onGet(`${endpoint}?team_name=new`).reply(200, readiness('new-model'));
  const team = ref('old');
  const { state } = create(team, ref(''));
  await flush();
  team.value = 'new';
  await flush();
  assert.equal(state.llm.value.model, 'new-model');
  finishOld([200, readiness('old-model')]);
  await flush();
  assert.equal(state.llm.value.model, 'new-model');
  assert.equal(state.loading.value, false);
});

test('配置失效后已挂载的选择器刷新，失败后可手动重试', async () => {
  mock.onGet(endpoint).replyOnce(500, {});
  const { state } = create(ref(''), ref(''));
  await flush();
  assert.equal(state.llm.value, null);
  mock.onGet(endpoint).reply(200, readiness('first'));
  await state.refresh();
  assert.equal(state.llm.value.model, 'first');
  mock.onGet(endpoint).reply(200, readiness('updated'));
  invalidateDefaultLlm();
  await flush();
  assert.equal(state.llm.value.model, 'updated');
});

test('卸载后不再用未完成的请求更新组件状态', async () => {
  let finish;
  mock.onGet(endpoint).reply(() => new Promise(resolve => { finish = resolve; }));
  const { scope, state } = create(ref(''), ref(''));
  await flush();
  scope.stop();
  finish([200, readiness('late')]);
  await flush();
  assert.equal(state.llm.value, null);
});
