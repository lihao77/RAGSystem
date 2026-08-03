import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

import { useSessionRunStore } from './session-run.js';

const strategies = {
  idle: 'history',
  running: 'attach_run',
  waiting_interaction: 'attach_run_and_present_interactions',
  suspended: 'restore_suspended_run_and_present_interactions',
  resuming: 'attach_resume',
  maintenance: 'watch_maintenance',
};

function snapshot(state, overrides = {}) {
  const active = ['running', 'waiting_interaction', 'suspended', 'resuming'].includes(state);
  return {
    state,
    load_strategy: strategies[state],
    allowed_actions: state === 'idle'
      ? ['send_message', 'start_maintenance']
      : state === 'running'
        ? ['send_followup', 'stop_run']
        : state === 'waiting_interaction' || state === 'suspended'
          ? ['respond_interaction', 'stop_run']
          : state === 'resuming' ? ['stop_run'] : [],
    active_run: active ? {
      run_id: `run-${state}`,
      status: state,
      execution_owner: state === 'suspended' ? 'detached' : 'attached',
      task: 'task',
      request_id: 'req-1',
      execution_kind: 'agent_stream',
      started_at: '2026-07-30T00:00:00.000Z',
      updated_at: '2026-07-30T00:00:01.000Z',
      activity: { models: [], tools: [], updated_at: '2026-07-30T00:00:01.000Z' },
    } : null,
    last_run: null,
    pending_interactions: state === 'waiting_interaction' || state === 'suspended'
      ? [{
          interaction_id: 'interaction-1',
          run_id: `run-${state}`,
          root_run_id: `run-${state}`,
          batch_id: 'batch-1',
          kind: 'approval',
          status: state === 'suspended' ? 'suspended' : 'waiting',
          requested_at: '2026-07-30T00:00:01.000Z',
          payload: { kind: 'approval', phase: 'required' },
        }]
      : [],
    resume_interaction_id: null,
    maintenance: state === 'maintenance'
      ? { kind: 'rollback', expires_at: '2026-07-30T00:01:00.000Z' }
      : null,
    observed_at: '2026-07-30T00:00:01.000Z',
    ...overrides,
  };
}

test('Session store 对六种 runtime 状态采用唯一加载策略和统一 busy 投影', () => {
  const cases = [
    ['idle', false, 'idle'],
    ['running', true, 'processing'],
    ['waiting_interaction', true, 'approval_waiting'],
    ['suspended', true, 'approval_waiting'],
    ['resuming', true, 'starting_agent'],
    ['maintenance', false, 'idle'],
  ];

  for (const [state, active, phase] of cases) {
    setActivePinia(createPinia());
    const store = useSessionRunStore();
    store.applySessionRuntime(snapshot(state));

    assert.equal(store.sessionRuntime.state, state);
    assert.equal(store.sessionRuntime.load_strategy, strategies[state]);
    assert.equal(store.activeRun.active, active);
    assert.equal(store.activeRun.phase, phase);
    assert.equal(store.isLoading, state !== 'idle');
  }
});

test('审批恢复后的 running 快照立即清除 approval_waiting，不等待下一轮事件', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const activeRun = snapshot('running').active_run;

  store.applySessionRuntime(snapshot('waiting_interaction', {
    active_run: { ...activeRun, status: 'waiting_interaction' },
  }));
  assert.equal(store.activeRun.phase, 'approval_waiting');

  store.applySessionRuntime(snapshot('running', {
    active_run: { ...activeRun, status: 'running', updated_at: '2026-07-30T00:00:02.000Z' },
    pending_interactions: [],
  }));

  assert.equal(store.sessionRuntime.state, 'running');
  assert.deepEqual(store.sessionRuntime.pending_interactions, []);
  assert.equal(store.activeRun.phase, 'processing');
});

test('running 快照用权威活动覆盖本地旧阶段', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.applySessionRuntime(snapshot('running'));
  store.activeRun.phase = 'tool_running';

  store.applySessionRuntime(snapshot('running', {
    active_run: {
      ...snapshot('running').active_run,
      updated_at: '2026-07-30T00:00:02.000Z',
    },
  }));

  assert.equal(store.activeRun.phase, 'processing');
});

test('SQLite 无时区运行时间按 UTC 解析', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const activeRun = snapshot('running').active_run;

  store.applySessionRuntime(snapshot('running', {
    active_run: { ...activeRun, started_at: '2026-08-03 08:00:00' },
  }));

  assert.equal(store.activeRun.runStartedAt, Date.UTC(2026, 7, 3, 8, 0, 0) / 1000);
});

test('running 快照恢复模型重试等待及真实 attempt 元数据', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const retryModel = {
    call_id: 'model-call',
    agent_id: 'agent',
    round: 2,
    status: 'retry_wait',
    attempt_id: 'attempt-1',
    attempt: 1,
    max_attempts: 3,
    provider: 'openai',
    model: 'gpt-test',
    started_at: '2026-07-30T00:00:00.100Z',
    retry_at: '2026-07-30T00:00:03.000Z',
    error: 'upstream unavailable',
    updated_at: '2026-07-30T00:00:01.000Z',
  };

  store.applySessionRuntime(snapshot('running', {
    active_run: {
      ...snapshot('running').active_run,
      activity: {
        models: [retryModel],
        tools: [],
        updated_at: '2026-07-30T00:00:01.000Z',
      },
    },
  }));

  assert.equal(store.activeRun.phase, 'retrying');
  assert.deepEqual(store.activeRun.runningModelCalls['agent\u0000model-call'], retryModel);
});

test('running 快照恢复子 Agent 模型与工具并行活动', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.applySessionRuntime(snapshot('running', {
    active_run: {
      ...snapshot('running').active_run,
      activity: {
        models: [{
          call_id: 'child-model',
          agent_id: 'child-agent',
          round: 1,
          status: 'streaming',
          attempt_id: 'attempt-child',
          attempt: 1,
          max_attempts: 2,
          provider: 'openai',
          model: 'gpt-test',
          started_at: '2026-07-30T00:00:00.100Z',
          retry_at: null,
          error: null,
          updated_at: '2026-07-30T00:00:01.000Z',
        }],
        tools: [{
          call_id: 'root-tool',
          agent_id: 'agent',
          parent_call_id: 'root-call',
          tool: 'read_file',
          started_at: '2026-07-30T00:00:00.500Z',
        }],
        updated_at: '2026-07-30T00:00:01.000Z',
      },
    },
  }));

  assert.equal(store.activeRun.phase, 'parallel_running');
  assert.equal(store.activeRun.runningToolCalls['root-tool'].tool, 'read_file');
  assert.equal(store.activeRun.runningToolCalls['root-tool'].agent_id, 'agent');
  assert.equal(store.activeRun.runningToolCalls['root-tool'].parent_call_id, 'root-call');
  assert.equal(Object.keys(store.activeRun.runningModelCalls).length, 1);
});

test('已响应但尚未恢复的 suspended 快照不会伪装成等待审批', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.applySessionRuntime(snapshot('suspended', {
    allowed_actions: ['resume_run', 'stop_run'],
    pending_interactions: [],
    resume_interaction_id: 'interaction-1',
  }));

  assert.equal(store.activeRun.phase, 'suspended');
});

test('终态只进入 last_run，不会伪装成 Session runtime state', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.applySessionRuntime(snapshot('idle', {
    last_run: {
      run_id: 'run-completed',
      status: 'completed',
      task: 'task',
      started_at: '2026-07-30T00:00:00.000Z',
      finished_at: '2026-07-30T00:00:02.000Z',
    },
  }));

  assert.equal(store.sessionRuntime.state, 'idle');
  assert.equal(store.sessionRuntime.last_run.status, 'completed');
  assert.equal(store.isLoading, false);
});

test('idle 权威快照会清除已结束 run 的 active 展示', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.applySessionRuntime(snapshot('running'));
  assert.equal(store.activeRun.active, true);

  store.applySessionRuntime(snapshot('idle'));

  assert.equal(store.activeRun.active, false);
  assert.equal(store.activeRun.assistantMsgIndex, -1);
});

test('所有操作权限只读取 allowed_actions，不能由 state 或 execution_owner 猜测', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.applySessionRuntime(snapshot('running', {
    active_run: {
      ...snapshot('running').active_run,
      execution_owner: 'remote',
    },
    allowed_actions: [],
  }));

  assert.equal(store.allowsRuntimeAction('stop_run'), false);
  assert.equal(store.allowsRuntimeAction('respond_interaction'), false);
  assert.equal(store.allowsRuntimeAction('send_followup'), false);

  store.applySessionRuntime(snapshot('suspended', {
    allowed_actions: ['resume_run'],
    resume_interaction_id: 'interaction-1',
    pending_interactions: [],
  }));
  assert.equal(store.allowsRuntimeAction('resume_run'), true);
  assert.equal(store.allowsRuntimeAction('send_message'), false);
});

test('乐观发送不改 runtime，并在权威快照到达时自动清除', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.applySessionRuntime(snapshot('idle', {
    allowed_actions: ['send_message'],
  }));

  store.beginOptimisticCommand('send');
  assert.equal(store.sessionRuntime.state, 'idle');
  assert.equal(store.optimisticCommand.kind, 'send');
  assert.equal(store.isLoading, true);

  store.applySessionRuntime(snapshot('running'));
  assert.equal(store.optimisticCommand, null);
  assert.equal(store.sessionRuntime.state, 'running');
});
