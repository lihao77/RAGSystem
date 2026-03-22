const ORCHESTRATOR_AGENT_NAME = 'orchestrator_agent';

const isOrchestrator = (agentName) => !agentName || agentName === ORCHESTRATOR_AGENT_NAME;

const createToolCall = (step) => ({
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

const createExecutionStep = (round = null) => ({
  round,
  intent: '',
  toolCalls: [],
  expanded: true,
  _intentComplete: false,
});

const createSubtask = (step) => ({
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
    toolMap: new Map(),
  };
}

function getLatestRound(executionSteps = []) {
  for (let i = executionSteps.length - 1; i >= 0; i -= 1) {
    const round = executionSteps[i]?.round;
    if (typeof round === 'number' && Number.isFinite(round)) return round;
  }
  return null;
}

function ensureOrchestratorStep(state, round = null) {
  const lastStep = state.execution_steps[state.execution_steps.length - 1];
  if (round == null) {
    if (lastStep) return lastStep;
    const fallback = createExecutionStep(1);
    state.execution_steps.push(fallback);
    return fallback;
  }

  let step = state.execution_steps.findLast?.(item => item?.round === round);
  if (!step) {
    step = lastStep;
  }
  if (!step || (step.round != null && step.round !== round)) {
    step = createExecutionStep(round);
    state.execution_steps.push(step);
  } else if (step.round == null) {
    step.round = round;
  }
  return step;
}

function ensureSubtaskIntentStep(subtask, round = null) {
  let step = subtask.currentStep;
  if (round != null) {
    const matched = subtask.react_steps.findLast?.(item => item?.round === round);
    if (matched) step = matched;
  }

  const resolvedRound = round ?? step?.round ?? subtask.round ?? 1;
  if (!step || (step.round != null && step.round !== resolvedRound)) {
    step = createExecutionStep(resolvedRound);
    subtask.react_steps.push(step);
  } else if (step.round == null) {
    step.round = resolvedRound;
  }
  subtask.currentStep = step;
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
    if (isOrchestrator(step.agent_name)) {
      const executionStep = ensureOrchestratorStep(state, step.round);
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
    const reactStep = ensureSubtaskIntentStep(subtask, step.round);
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
      const toolCall = createToolCall(step);
      state.toolMap.set(step.call_id, toolCall);
      const subtask = state.subtaskMap.get(step.parent_call_id);
      if (subtask) {
        const reactStep = ensureSubtaskIntentStep(subtask, step.round);
        reactStep.toolCalls.push(toolCall);
        subtask.tool_calls.push(toolCall);
      } else {
        ensureOrchestratorStep(state, step.round).toolCalls.push(toolCall);
      }
      return state;
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
