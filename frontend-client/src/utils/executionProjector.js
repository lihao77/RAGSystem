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
  approval_message: step.approval_message || '',
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
  status: 'running',
  run_status: null,
  agent_name: 'orchestrator_agent',
  agent_display_name: '',
  _intentComplete: false,
});

function normalizeTerminalStatus(status) {
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'cancelled' || status === 'stopped') return 'stopped';
  return 'success';
}

function resolveCompletedIntentStatus(step, executionStep) {
  if (executionStep.run_status && executionStep.run_status !== 'running') {
    return executionStep.run_status;
  }
  return normalizeTerminalStatus(step.status);
}

function resolveAgentDisplayName(state, agentName, explicitDisplayName) {
  return explicitDisplayName || state.agentNameDisplayNameMap.get(agentName) || agentName || 'orchestrator_agent';
}

function rememberAgentDisplayName(state, step) {
  if (!step?.agent_name || !step?.agent_display_name) return;
  state.agentNameDisplayNameMap.set(step.agent_name, step.agent_display_name);
}

const createSubtask = (state, step) => ({
  step_id: step.step_id || null,
  parent_step_id: step.parent_step_id || null,
  order: step.order,
  task_id: step.call_id,
  parent_call_id: step.parent_call_id,
  parent_task_id: null,
  round: step.round,
  round_index: step.round_index,
  agent_name: step.agent_name || '',
  agent_display_name: resolveAgentDisplayName(state, step.agent_name, step.agent_display_name),
  description: step.description || '',
  react_steps: [],
  tool_calls: [],
  children: [],
  result_summary: '',
  status: step.status || 'running',
  expanded: true,
  currentStep: null,
  ctx: null,
  _attached: false,
});

export function createExecutionState() {
  return {
    rawSteps: [],
    subtasks: [],
    execution_steps: [],
    subtaskMap: new Map(),
    stepMap: new Map(),
    toolMap: new Map(),
    pendingToolCallsByParentCallId: new Map(),
    pendingSubtasksByParentCallId: new Map(),
    agentNameDisplayNameMap: new Map(),
    rootCallIds: new Set(),
    // call_agent tool 等待与 subtask 关联的队列，key = `${parent_call_id}:${round}`
    pendingCallAgentTools: new Map(),
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

function addSubtaskOnce(subtasks, subtask) {
  if (!Array.isArray(subtasks)) return;
  if (subtasks.some(item => item?.task_id === subtask?.task_id)) return;
  subtasks.push(subtask);
}

function queuePendingToolCall(state, step, toolCall) {
  if (!step?.parent_call_id) return;
  const pending = state.pendingToolCallsByParentCallId.get(step.parent_call_id) || [];
  if (!pending.some(item => item?.toolCall?.call_id === toolCall?.call_id)) {
    pending.push({ step, toolCall });
    state.pendingToolCallsByParentCallId.set(step.parent_call_id, pending);
  }
}

function queuePendingSubtask(state, subtask) {
  if (!subtask?.parent_call_id) return;
  const pending = state.pendingSubtasksByParentCallId.get(subtask.parent_call_id) || [];
  if (!pending.some(item => item?.task_id === subtask?.task_id)) {
    pending.push(subtask);
    state.pendingSubtasksByParentCallId.set(subtask.parent_call_id, pending);
  }
}

function isKnownRootParent(state, parentCallId) {
  if (!parentCallId) return true;
  return state.rootCallIds.has(parentCallId);
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
    for (const subtask of state.subtaskMap.values()) {
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

function flushPendingSubtasks(state, parentSubtask) {
  const pending = state.pendingSubtasksByParentCallId.get(parentSubtask.task_id);
  if (!pending?.length) return;
  pending.forEach((subtask) => {
    attachSubtaskToTree(state, subtask);
  });
  state.pendingSubtasksByParentCallId.delete(parentSubtask.task_id);
}

function flushRootPendingSubtasks(state) {
  for (const [parentCallId, subtasks] of state.pendingSubtasksByParentCallId.entries()) {
    if (!isKnownRootParent(state, parentCallId)) continue;
    subtasks.forEach((subtask) => {
      attachSubtaskToTree(state, subtask);
    });
    state.pendingSubtasksByParentCallId.delete(parentCallId);
  }
}

function attachSubtaskToTree(state, subtask) {
  if (!subtask || subtask._attached) return;

  const parentSubtask = state.subtaskMap.get(subtask.parent_call_id);
  if (parentSubtask) {
    addSubtaskOnce(parentSubtask.children, subtask);
    subtask.parent_task_id = parentSubtask.task_id;
    subtask._attached = true;
    flushPendingSubtasks(state, subtask);
    return;
  }

  if (isKnownRootParent(state, subtask.parent_call_id)) {
    addSubtaskOnce(state.subtasks, subtask);
    subtask.parent_task_id = null;
    subtask._attached = true;
    flushPendingSubtasks(state, subtask);
    return;
  }

  queuePendingSubtask(state, subtask);
}

function handleToolStart(state, step) {
  const toolCall = createToolCall(step);
  state.toolMap.set(step.call_id, toolCall);

  // call_agent 工具：加入待关联队列，等 subtask.start 来匹配
  if (step.tool_name === 'call_agent' && step.parent_call_id) {
    const key = `${step.parent_call_id}:${step.round ?? ''}`;
    const queue = state.pendingCallAgentTools.get(key) || [];
    queue.push(toolCall);
    state.pendingCallAgentTools.set(key, queue);
  }

  const subtask = findSubtaskByToolStep(state, step);
  if (subtask) {
    attachToolCallToSubtask(state, subtask, step, toolCall);
    return state;
  }

  if (step.parent_call_id && !isKnownRootParent(state, step.parent_call_id)) {
    queuePendingToolCall(state, step, toolCall);
    return state;
  }

  const existingRootStep = step.parent_step_id ? state.stepMap.get(step.parent_step_id) : null;
  if (existingRootStep || state.execution_steps.length > 0) {
    const rootStep = existingRootStep || ensureOrchestratorStep(state, step.round, step.parent_step_id || step.step_id || null, null);
    addToolCallOnce(rootStep.toolCalls, toolCall);
    if (step.agent_name) rootStep.agent_name = step.agent_name;
    rootStep.agent_display_name = resolveAgentDisplayName(
      state,
      rootStep.agent_name,
      step.agent_display_name || rootStep.agent_display_name,
    );
    rootStep.status = 'running';
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

function handleRunStep(state, step) {
  if (step.call_id) state.rootCallIds.add(step.call_id);
  const executionStep = ensureOrchestratorStep(
    state,
    step.round ?? getLatestRound(state.execution_steps) ?? 1,
    step.step_id || null,
    step.parent_step_id || null,
  );
  if (step.agent_name) executionStep.agent_name = step.agent_name;
  executionStep.agent_display_name = resolveAgentDisplayName(
    state,
    executionStep.agent_name,
    step.agent_display_name || executionStep.agent_display_name,
  );
  executionStep.run_status = step.phase === 'end'
    ? (step.status === 'error' ? 'error' : 'success')
    : 'running';
  if (!executionStep.status || executionStep.status === 'running' || step.phase === 'end') {
    executionStep.status = executionStep.run_status;
  }
  flushRootPendingSubtasks(state);
  return state;
}

export function applyStep(state, step) {
  if (!state || !step || step.kind == null || step.phase == null) return state;
  rememberAgentDisplayName(state, step);
  state.rawSteps.push(step);

  if (step.kind === 'run') {
    return handleRunStep(state, step);
  }

  if (step.kind === 'subtask') {
    if (step.phase === 'start') {
      const subtask = state.subtaskMap.get(step.call_id) || createSubtask(state, step);
      subtask.step_id = step.step_id || subtask.step_id;
      subtask.parent_step_id = step.parent_step_id || subtask.parent_step_id;
      subtask.parent_call_id = step.parent_call_id || subtask.parent_call_id;
      subtask.order = step.order ?? subtask.order;
      subtask.round = step.round ?? subtask.round;
      subtask.round_index = step.round_index ?? subtask.round_index;
      subtask.agent_name = step.agent_name || subtask.agent_name;
      subtask.agent_display_name = resolveAgentDisplayName(
        state,
        subtask.agent_name,
        step.agent_display_name || subtask.agent_display_name,
      );
      subtask.description = step.description || subtask.description;
      subtask.status = 'running';
      subtask.expanded = true;
      if (!state.subtaskMap.has(step.call_id)) {
        state.subtaskMap.set(step.call_id, subtask);
      }
      if (subtask.step_id) state.stepMap.set(subtask.step_id, subtask);

      // 关联对应的 call_agent toolCall（按 parent_call_id + round 顺序出队）
      if (step.parent_call_id) {
        const key = `${step.parent_call_id}:${step.round ?? ''}`;
        const queue = state.pendingCallAgentTools.get(key);
        if (queue && queue.length > 0) {
          const toolCall = queue.shift();
          toolCall.linked_task_id = step.call_id;
          subtask.linked_tool_call_id = toolCall.call_id;
          if (queue.length === 0) state.pendingCallAgentTools.delete(key);
        }
      }

      attachSubtaskToTree(state, subtask);
      flushPendingToolCalls(state, subtask);
      return state;
    }

    if (step.phase === 'end') {
      const subtask = state.subtaskMap.get(step.call_id);
      if (subtask) {
        subtask.agent_name = step.agent_name || subtask.agent_name;
        subtask.agent_display_name = resolveAgentDisplayName(
          state,
          subtask.agent_name,
          step.agent_display_name || subtask.agent_display_name,
        );
        subtask.status = step.status === 'error' ? 'error' : 'success';
        subtask.result_summary = step.result_preview ?? step.result ?? subtask.result_summary;
        subtask.expanded = false;
      }
      return state;
    }
  }

  if (step.kind === 'intent') {
    if (isRootExecutionStep(step)) {
      if (step.call_id) state.rootCallIds.add(step.call_id);
      const executionStep = ensureOrchestratorStep(state, step.round, step.step_id, step.parent_step_id);
      if (step.agent_name) executionStep.agent_name = step.agent_name;
      executionStep.agent_display_name = resolveAgentDisplayName(
        state,
        executionStep.agent_name,
        step.agent_display_name || executionStep.agent_display_name,
      );
      if (step.content) {
        if (step.phase === 'delta' && !executionStep._intentComplete) {
          executionStep.intent += step.content;
        } else {
          executionStep.intent = step.content;
        }
      }
      if (step.phase === 'complete') executionStep._intentComplete = true;
      executionStep.status = executionStep.toolCalls.some(item => item?.status === 'running')
        ? 'running'
        : (step.phase === 'complete'
          ? resolveCompletedIntentStatus(step, executionStep)
          : (executionStep.run_status || executionStep.status || 'running'));
      flushRootPendingSubtasks(state);
      return state;
    }

    const subtask = state.subtaskMap.get(step.call_id);
    if (!subtask) return state;
    const reactStep = ensureSubtaskIntentStep(state, subtask, step.round, step.step_id, step.parent_step_id);
    if (step.agent_name) reactStep.agent_name = step.agent_name;
    reactStep.agent_display_name = resolveAgentDisplayName(
      state,
      reactStep.agent_name || subtask.agent_name,
      step.agent_display_name || reactStep.agent_display_name || subtask.agent_display_name,
    );
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
        toolCall.approval_message = step.approval_message || '';
        toolCall.elapsed_time = step.elapsed_time;
      }
      const rootStep = step.parent_step_id ? state.stepMap.get(step.parent_step_id) : null;
      if (rootStep && rootStep.toolCalls?.every(item => item?.status !== 'running')) {
        rootStep.status = rootStep.run_status || 'success';
      }
      return state;
    }
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
