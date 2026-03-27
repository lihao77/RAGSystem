const isRootExecutionStep = (step) => !step?.parent_call_id;

const createToolCall = (step) => ({
  step_id: step.step_id || null,
  parent_step_id: step.parent_step_id || null,
  call_id: step.call_id,
  parent_call_id: step.parent_call_id,
  tool_name: step.tool_name,
  arguments: step.arguments || {},
  status: step.phase === 'end' ? (step.status === 'error' ? 'error' : 'success') : 'running',
  result: step.result_preview ?? step.result ?? '',
  result_preview: step.result_preview ?? step.result ?? '',
  raw_result: step.raw_result ?? null,
  raw_result_ref: step.raw_result_ref || null,
  raw_result_available: Boolean(step.raw_result_available) || step.raw_result != null,
  elapsed_time: step.elapsed_time,
  showResult: false,
  showArgs: false,
});

const createExecutionStep = (round = null, stepId = null, parentStepId = null) => ({
  step_id: stepId,
  parent_step_id: parentStepId,
  round,
  intent: '',
  toolCalls: [],
  expanded: true,
  _intentComplete: false,
});

const createSubtask = (step) => ({
  step_id: step.step_id || null,
  parent_step_id: step.parent_step_id || null,
  order: step.order,
  task_id: step.call_id,
  parent_call_id: step.parent_call_id,
  round: step.round,
  round_index: step.round_index,
  agent_name: step.agent_name || '',
  agent_display_name: step.agent_display_name || step.agent_name || '',
  description: step.description || '',
  react_steps: [],
  tool_calls: [],
  result_summary: '',
  status: step.status || 'running',
  expanded: true,
  currentStep: null,
  ctx: null,
});

const createMultimodalContent = (step) => {
  if (step.visualization_type === 'chart') {
    return {
      type: 'chart',
      echartsConfig: step.data?.echarts_config || step.data?.config,
      title: step.data?.title || 'Data Visualization',
      chartType: step.data?.chart_type || 'bar',
    };
  }
  if (step.visualization_type === 'map') {
    return {
      type: 'map',
      mapData: step.data?.mapData || step.data?.data,
      title: step.data?.title || 'Map Visualization',
    };
  }
  return null;
};

export function createExecutionState() {
  return {
    rawSteps: [],
    subtasks: [],
    execution_steps: [],
    multimodalContents: [],
    subtaskMap: new Map(),
    stepMap: new Map(),
    toolMap: new Map(),
    pendingToolCallsByParentCallId: new Map(),
  };
}

function getLatestRound(executionSteps = []) {
  for (let i = executionSteps.length - 1; i >= 0; i -= 1) {
    const round = executionSteps[i]?.round;
    if (typeof round === 'number' && Number.isFinite(round)) return round;
  }
  return null;
}

function ensureOrchestratorStep(state, round = null, stepId = null, parentStepId = null) {
  if (stepId && state.stepMap.has(stepId)) {
    const matched = state.stepMap.get(stepId);
    if (matched.round == null && round != null) matched.round = round;
    return matched;
  }

  const lastStep = state.execution_steps[state.execution_steps.length - 1];
  if (round == null && !stepId) {
    if (lastStep) return lastStep;
    const fallback = createExecutionStep(1, null, parentStepId);
    state.execution_steps.push(fallback);
    return fallback;
  }

  let step = null;
  if (stepId) step = state.execution_steps.find(item => item?.step_id === stepId) || null;
  if (!step && round != null) {
    step = state.execution_steps.findLast?.(item => item?.round === round && item?.parent_step_id === parentStepId);
  }
  if (!step) {
    step = lastStep;
  }
  if (!step || (round != null && step.round != null && step.round !== round)) {
    step = createExecutionStep(round ?? 1, stepId, parentStepId);
    state.execution_steps.push(step);
  } else {
    if (step.round == null && round != null) step.round = round;
    if (step.step_id == null && stepId) step.step_id = stepId;
    if (step.parent_step_id == null && parentStepId) step.parent_step_id = parentStepId;
  }
  if (step.step_id) state.stepMap.set(step.step_id, step);
  return step;
}

function addToolCallOnce(toolCalls, toolCall) {
  if (!Array.isArray(toolCalls)) return;
  if (toolCalls.some(item => item?.call_id === toolCall?.call_id)) return;
  toolCalls.push(toolCall);
}

function queuePendingToolCall(state, step, toolCall) {
  if (!step?.parent_call_id) return;
  const pending = state.pendingToolCallsByParentCallId.get(step.parent_call_id) || [];
  if (!pending.some(item => item?.toolCall?.call_id === toolCall?.call_id)) {
    pending.push({ step, toolCall });
    state.pendingToolCallsByParentCallId.set(step.parent_call_id, pending);
  }
}

function attachToolCallToSubtask(state, subtask, step, toolCall) {
  const reactStepId = step.parent_step_id === subtask.step_id ? null : step.parent_step_id;
  const reactStep = ensureSubtaskIntentStep(state, subtask, step.round, reactStepId, subtask.step_id);
  addToolCallOnce(reactStep.toolCalls, toolCall);
  addToolCallOnce(subtask.tool_calls, toolCall);
}

function findSubtaskByToolStep(state, step) {
  const byParentCallId = state.subtaskMap.get(step.parent_call_id);
  if (byParentCallId) return byParentCallId;

  if (step.parent_step_id) {
    for (const subtask of state.subtasks) {
      if (!subtask) continue;
      if (subtask.step_id === step.parent_step_id) return subtask;
      if (subtask.react_steps?.some(item => item?.step_id === step.parent_step_id)) return subtask;
    }
  }

  return null;
}

function flushPendingToolCalls(state, subtask) {
  const pending = state.pendingToolCallsByParentCallId.get(subtask.task_id);
  if (!pending?.length) return;
  pending.forEach(({ step, toolCall }) => {
    attachToolCallToSubtask(state, subtask, step, toolCall);
  });
  state.pendingToolCallsByParentCallId.delete(subtask.task_id);
}

function handleToolStart(state, step) {
  const toolCall = createToolCall(step);
  state.toolMap.set(step.call_id, toolCall);

  const subtask = findSubtaskByToolStep(state, step);
  if (subtask) {
    attachToolCallToSubtask(state, subtask, step, toolCall);
    return state;
  }

  const existingRootStep = step.parent_step_id ? state.stepMap.get(step.parent_step_id) : null;
  if (existingRootStep || state.execution_steps.length > 0) {
    const rootStep = existingRootStep || ensureOrchestratorStep(state, step.round, step.parent_step_id || step.step_id || null, null);
    addToolCallOnce(rootStep.toolCalls, toolCall);
    if (rootStep.step_id) state.stepMap.set(rootStep.step_id, rootStep);
    return state;
  }

  queuePendingToolCall(state, step, toolCall);
  return state;
}

function ensureSubtaskIntentStep(state, subtask, round = null, stepId = null, parentStepId = null) {
  let step = stepId ? state.stepMap.get(stepId) : null;
  if (!step) {
    step = subtask.currentStep;
  }
  if (!step && round != null) {
    step = subtask.react_steps.findLast?.(item => item?.round === round || item?.step_id === stepId);
  }

  const resolvedRound = round ?? step?.round ?? subtask.round ?? 1;
  if (!step || (step.round != null && step.round !== resolvedRound && step.step_id !== stepId)) {
    step = createExecutionStep(resolvedRound, stepId, parentStepId || subtask.step_id || null);
    subtask.react_steps.push(step);
  } else {
    if (step.round == null && resolvedRound != null) step.round = resolvedRound;
    if (step.step_id == null && stepId) step.step_id = stepId;
    if (step.parent_step_id == null && (parentStepId || subtask.step_id)) {
      step.parent_step_id = parentStepId || subtask.step_id;
    }
  }
  subtask.currentStep = step;
  if (step.step_id) state.stepMap.set(step.step_id, step);
  return step;
}

export function applyStep(state, step) {
  if (!state || !step || step.kind == null || step.phase == null) return state;
  state.rawSteps.push(step);

  if (step.kind === 'run') {
    return state;
  }

  if (step.kind === 'subtask') {
    if (step.phase === 'start') {
      const subtask = state.subtaskMap.get(step.call_id) || createSubtask(step);
      subtask.step_id = step.step_id || subtask.step_id;
      subtask.parent_step_id = step.parent_step_id || subtask.parent_step_id;
      subtask.order = step.order ?? subtask.order;
      subtask.round = step.round ?? subtask.round;
      subtask.round_index = step.round_index ?? subtask.round_index;
      subtask.agent_name = step.agent_name || subtask.agent_name;
      subtask.agent_display_name = step.agent_display_name || subtask.agent_display_name || subtask.agent_name;
      subtask.description = step.description || subtask.description;
      subtask.status = 'running';
      subtask.expanded = true;
      if (!state.subtaskMap.has(step.call_id)) {
        state.subtasks.push(subtask);
        state.subtaskMap.set(step.call_id, subtask);
      }
      if (subtask.step_id) state.stepMap.set(subtask.step_id, subtask);
      flushPendingToolCalls(state, subtask);
      return state;
    }

    if (step.phase === 'end') {
      const subtask = state.subtaskMap.get(step.call_id);
      if (subtask) {
        subtask.status = step.status === 'error' ? 'error' : 'success';
        subtask.result_summary = step.result_preview ?? step.result ?? subtask.result_summary;
        subtask.expanded = false;
      }
      return state;
    }
  }

  if (step.kind === 'intent') {
    if (isRootExecutionStep(step)) {
      const executionStep = ensureOrchestratorStep(state, step.round, step.step_id, step.parent_step_id);
      if (step.agent_name) executionStep.agent_name = step.agent_name;
      if (step.agent_display_name) executionStep.agent_display_name = step.agent_display_name;
      if (step.content) {
        if (step.phase === 'delta' && !executionStep._intentComplete) {
          executionStep.intent += step.content;
        } else {
          executionStep.intent = step.content;
        }
      }
      if (step.phase === 'complete') executionStep._intentComplete = true;
      return state;
    }

    const subtask = state.subtaskMap.get(step.call_id);
    if (!subtask) return state;
    const reactStep = ensureSubtaskIntentStep(state, subtask, step.round, step.step_id, step.parent_step_id);
    if (step.content) {
      if (step.phase === 'delta' && !reactStep._intentComplete) {
        reactStep.intent += step.content;
      } else {
        reactStep.intent = step.content;
      }
    }
    if (step.phase === 'complete') reactStep._intentComplete = true;
    return state;
  }

  if (step.kind === 'tool') {
    if (step.phase === 'start') {
      return handleToolStart(state, step);
    }

    if (step.phase === 'end') {
      const toolCall = state.toolMap.get(step.call_id);
      if (toolCall) {
        toolCall.status = step.status === 'error' ? 'error' : 'success';
        toolCall.result = step.result_preview ?? step.result ?? '';
        toolCall.result_preview = step.result_preview ?? step.result ?? '';
        toolCall.raw_result = step.raw_result ?? null;
        toolCall.raw_result_ref = step.raw_result_ref || null;
        toolCall.raw_result_available = Boolean(step.raw_result_available) || step.raw_result != null;
        toolCall.elapsed_time = step.elapsed_time;
      }
      return state;
    }
  }

  if (step.kind === 'visualization') {
    const content = createMultimodalContent(step);
    if (content) state.multimodalContents.push(content);
  }

  return state;
}

export function buildExecutionState(steps = []) {
  const state = createExecutionState();
  for (const step of steps) {
    applyStep(state, step);
  }
  return state;
}
