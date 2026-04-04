import test from 'node:test';
import assert from 'node:assert/strict';

import { applyStep, buildExecutionState, createExecutionState } from './executionProjector.js';

function createRunStart(overrides = {}) {
  return {
    kind: 'run',
    phase: 'start',
    call_id: 'root-call',
    parent_call_id: null,
    step_id: 'root-call:run',
    parent_step_id: null,
    agent_name: 'orchestrator_agent',
    agent_display_name: 'orchestrator_agent',
    round: 1,
    status: 'running',
    ...overrides,
  };
}

function createRunEnd(overrides = {}) {
  return {
    kind: 'run',
    phase: 'end',
    call_id: 'root-call',
    parent_call_id: null,
    step_id: 'root-call:run',
    parent_step_id: null,
    agent_name: 'orchestrator_agent',
    agent_display_name: 'orchestrator_agent',
    round: 1,
    status: 'success',
    ...overrides,
  };
}

function createSubtaskStart(overrides = {}) {
  return {
    kind: 'subtask',
    phase: 'start',
    call_id: 'subtask-1',
    parent_call_id: 'root-call',
    step_id: 'subtask-1:call',
    parent_step_id: 'root-call:round:1',
    agent_name: 'child_agent',
    agent_display_name: '子 Agent',
    description: '执行子任务',
    round: 1,
    round_index: 1,
    order: 1,
    status: 'running',
    ...overrides,
  };
}

function createToolStart(overrides = {}) {
  return {
    kind: 'tool',
    phase: 'start',
    call_id: 'tool-1',
    parent_call_id: 'subtask-1',
    step_id: 'tool-1:tool',
    parent_step_id: 'subtask-1:round:1',
    agent_name: 'child_agent',
    tool_name: 'search_docs',
    arguments: { query: 'flood' },
    round: 1,
    status: 'running',
    ...overrides,
  };
}

function createToolEnd(overrides = {}) {
  return {
    kind: 'tool',
    phase: 'end',
    call_id: 'tool-1',
    parent_call_id: 'subtask-1',
    step_id: 'tool-1:tool',
    parent_step_id: 'subtask-1:round:1',
    agent_name: 'child_agent',
    tool_name: 'search_docs',
    result_preview: 'done',
    result: 'done',
    raw_result: { ok: true },
    raw_result_ref: { call_id: 'tool-1' },
    raw_result_available: true,
    approval_message: 'allow',
    elapsed_time: 0.2,
    round: 1,
    status: 'success',
    ...overrides,
  };
}

function createOrchestratorToolStart(overrides = {}) {
  return {
    kind: 'tool',
    phase: 'start',
    call_id: 'tool-root-1',
    parent_call_id: 'root-call',
    step_id: 'tool-root-1:tool',
    parent_step_id: 'root-call:round:1',
    agent_name: 'orchestrator_agent',
    tool_name: 'query_index',
    arguments: { keyword: 'rain' },
    round: 1,
    status: 'running',
    ...overrides,
  };
}

test('run step 会投影为可显示的根级 execution step', () => {
  const state = createExecutionState();

  applyStep(state, createRunStart({
    agent_name: 'emergency_agent',
    agent_display_name: '应急决策助手'
  }));

  assert.equal(state.execution_steps.length, 1);
  assert.equal(state.execution_steps[0].step_id, 'root-call:run');
  assert.equal(state.execution_steps[0].status, 'running');
  assert.equal(state.execution_steps[0].run_status, 'running');
  assert.equal(state.execution_steps[0].agent_name, 'emergency_agent');
  assert.equal(state.execution_steps[0].agent_display_name, '应急决策助手');
});

test('run-only 历史步骤回放后仍保留执行节点', () => {
  const rebuilt = buildExecutionState([
    createRunStart(),
    createRunEnd(),
  ]);

  assert.equal(rebuilt.execution_steps.length, 1);
  assert.equal(rebuilt.execution_steps[0].status, 'success');
  assert.equal(rebuilt.execution_steps[0].run_status, 'success');
});

test('run end 未显式携带中文名时仍保留已记忆的 display name', () => {
  const state = createExecutionState();

  applyStep(state, createRunStart({
    agent_name: 'emergency_agent',
    agent_display_name: '应急决策助手',
  }));
  applyStep(state, createRunEnd({
    agent_name: 'emergency_agent',
    agent_display_name: '',
  }));

  assert.equal(state.execution_steps[0].agent_display_name, '应急决策助手');
});

test('将正常顺序的子 agent 工具调用挂到对应 agent_call 内部', () => {
  const state = createExecutionState();

  applyStep(state, createSubtaskStart());
  applyStep(state, createToolStart());
  applyStep(state, createToolEnd());

  assert.equal(state.subtasks.length, 1);
  assert.equal(state.execution_steps.length, 0);

  const [subtask] = state.subtasks;
  assert.equal(subtask.tool_calls.length, 1);
  assert.equal(subtask.react_steps.length, 1);
  assert.equal(subtask.react_steps[0].toolCalls.length, 1);
  assert.equal(subtask.tool_calls[0].call_id, 'tool-1');
  assert.equal(subtask.tool_calls[0].status, 'success');
  assert.equal(subtask.tool_calls[0].result_preview, 'done');
  assert.equal(subtask.tool_calls[0].approval_message, 'allow');
});

test('子 agent 后续 intent/tool 未显式携带中文名时仍沿用已记忆的 display name', () => {
  const state = createExecutionState();

  applyStep(state, createSubtaskStart({
    agent_name: 'child_agent',
    agent_display_name: '子 Agent',
  }));
  applyStep(state, {
    kind: 'intent',
    phase: 'complete',
    call_id: 'subtask-1',
    parent_call_id: 'root-call',
    step_id: 'subtask-1:round:1',
    parent_step_id: 'subtask-1:call',
    agent_name: 'child_agent',
    round: 1,
    content: '继续分析',
    status: 'completed',
  });
  applyStep(state, createToolStart({ agent_display_name: '' }));

  const [subtask] = state.subtasks;
  assert.equal(subtask.agent_display_name, '子 Agent');
  assert.equal(subtask.react_steps[0].agent_display_name, '子 Agent');
});

test('当 tool start 先于 subtask start 到达时，稍后回填到对应子 agent', () => {
  const state = createExecutionState();

  applyStep(state, createToolStart());
  assert.equal(state.subtasks.length, 0);
  assert.equal(state.execution_steps.length, 0);
  assert.equal(state.pendingToolCallsByParentCallId.get('subtask-1')?.length, 1);

  applyStep(state, createSubtaskStart());
  applyStep(state, createToolEnd());

  const [subtask] = state.subtasks;
  assert.ok(subtask);
  assert.equal(subtask.tool_calls.length, 1);
  assert.equal(subtask.react_steps.length, 1);
  assert.equal(subtask.react_steps[0].toolCalls.length, 1);
  assert.equal(subtask.tool_calls[0].status, 'success');
  assert.equal(state.pendingToolCallsByParentCallId.has('subtask-1'), false);
  assert.equal(state.execution_steps.length, 0);
});

test('当 parent_call_id 不稳定时，可回退用 parent_step_id 归到子 agent', () => {
  const state = createExecutionState();

  applyStep(state, createSubtaskStart());
  applyStep(state, createToolStart({
    parent_call_id: 'unexpected-parent',
    parent_step_id: 'subtask-1:call',
  }));
  applyStep(state, createToolEnd({
    parent_call_id: 'unexpected-parent',
    parent_step_id: 'subtask-1:call',
  }));

  const [subtask] = state.subtasks;
  assert.ok(subtask);
  assert.equal(subtask.tool_calls.length, 1);
  assert.equal(subtask.react_steps.length, 1);
  assert.equal(subtask.tool_calls[0].call_id, 'tool-1');
  assert.equal(state.execution_steps.length, 0);
});

test('编排器自己的工具调用仍保留在 execution_steps 中', () => {
  const state = createExecutionState();

  applyStep(state, {
    kind: 'intent',
    phase: 'complete',
    call_id: 'root-call',
    parent_call_id: null,
    step_id: 'root-call:round:1',
    parent_step_id: 'root-call:run',
    agent_name: 'orchestrator_agent',
    round: 1,
    content: '先检索',
    status: 'completed',
  });
  applyStep(state, createOrchestratorToolStart());

  assert.equal(state.execution_steps.length, 1);
  assert.equal(state.execution_steps[0].toolCalls.length, 1);
  assert.equal(state.execution_steps[0].toolCalls[0].call_id, 'tool-root-1');
  assert.equal(state.subtasks.length, 0);
});

test('编排器自己的工具调用会沿用已记忆的 display name', () => {
  const state = createExecutionState();

  applyStep(state, createRunStart({
    agent_name: 'orchestrator_agent',
    agent_display_name: '总控编排器',
  }));
  applyStep(state, createOrchestratorToolStart({ agent_display_name: '' }));

  assert.equal(state.execution_steps[0].agent_display_name, '总控编排器');
  assert.equal(state.execution_steps[0].toolCalls[0].call_id, 'tool-root-1');
});

test('根级 intent 未携带 display name 时仍保留 run step 的入口名称', () => {
  const state = createExecutionState();

  applyStep(state, createRunStart({
    agent_name: 'planner_agent',
    agent_display_name: '规划助手',
  }));
  applyStep(state, {
    kind: 'intent',
    phase: 'complete',
    call_id: 'root-call',
    parent_call_id: null,
    step_id: 'root-call:round:1',
    parent_step_id: 'root-call:run',
    agent_name: 'planner_agent',
    agent_display_name: '',
    round: 1,
    content: '先梳理需求',
    status: 'completed',
  });

  assert.equal(state.execution_steps.length, 1);
  assert.equal(state.execution_steps[0].agent_display_name, '规划助手');
  assert.equal(state.execution_steps[0].intent, '先梳理需求');
});





test('没有 intent 内容时不应把 run 占位节点当作 thought 展示来源', () => {
  const executionSteps = [
    {
      step_id: 'root-call:run',
      round: 1,
      status: 'running',
      run_status: 'running',
      agent_name: 'orchestrator_agent',
      agent_display_name: '总控编排器',
      toolCalls: [],
    },
  ];

  const displayStep = [...executionSteps].reverse().find(step => step.intent || step.thinking || step.thought) || null;

  assert.equal(displayStep, null);
});
