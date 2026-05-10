/**
 * 执行树构建纯函数
 * 从 HierarchicalExecutionTree.vue 提取，供工作栏时间线复用
 */

export const createToolNode = (tool) => ({
  type: 'tool_call',
  call_id: tool.call_id,
  tool_name: tool.tool_name,
  arguments: tool.arguments,
  result: tool.result,
  result_preview: tool.result_preview,
  raw_result: tool.raw_result,
  raw_result_ref: tool.raw_result_ref,
  raw_result_available: tool.raw_result_available,
  status: tool.status,
  elapsed_time: tool.elapsed_time,
  expanded: tool.expanded || false,
  linked_task_id: tool.linked_task_id || null,
});

export const sortSubtasks = (subtasks = []) => [...subtasks].sort((a, b) => {
  const aIndex = a?.round_index ?? Number.MAX_SAFE_INTEGER;
  const bIndex = b?.round_index ?? Number.MAX_SAFE_INTEGER;
  if (aIndex !== bIndex) return aIndex - bIndex;
  const aOrder = a?.order ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b?.order ?? Number.MAX_SAFE_INTEGER;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return String(a?.task_id || '').localeCompare(String(b?.task_id || ''));
});

export const createAgentCallNode = (subtask) => {
  const agentCallNode = {
    type: 'agent_call',
    task_id: subtask.task_id,
    agent_name: subtask.agent_name,
    agent_display_name: subtask.agent_display_name,
    description: subtask.description,
    result_summary: subtask.result_summary,
    status: subtask.status,
    order: subtask.order,
    round: subtask.round,
    round_index: subtask.round_index,
    expanded: subtask.expanded || false,
    ctx: subtask.ctx || null,
    children: []
  };

  const childSubtaskByTaskId = new Map();
  sortSubtasks(subtask.children || []).forEach(child => {
    childSubtaskByTaskId.set(child.task_id, child);
  });

  const attachedToolIds = new Set();
  const linkedChildIds = new Set();

  if (subtask.react_steps && subtask.react_steps.length > 0) {
    subtask.react_steps.forEach(reactStep => {
      const reactTools = Array.isArray(reactStep.toolCalls) ? reactStep.toolCalls : [];
      reactTools.forEach(tool => {
        if (tool?.call_id) attachedToolIds.add(tool.call_id);
      });

      const hasIntent = Boolean(reactStep.intent || reactStep.thinking || reactStep.thought);
      if (!hasIntent) {
        reactTools.forEach(tool => {
          if (tool.linked_task_id && childSubtaskByTaskId.has(tool.linked_task_id)) {
            agentCallNode.children.push(createAgentCallNode(childSubtaskByTaskId.get(tool.linked_task_id)));
            linkedChildIds.add(tool.linked_task_id);
          } else {
            agentCallNode.children.push(createToolNode(tool));
          }
        });
        return;
      }

      const reactNode = {
        type: 'thought',
        agent: subtask.agent_name,
        agent_display_name: subtask.agent_display_name,
        round: reactStep.round,
        intent: reactStep.intent || reactStep.thinking || reactStep.thought || '',
        children: reactTools.map(tool => {
          if (tool.linked_task_id && childSubtaskByTaskId.has(tool.linked_task_id)) {
            linkedChildIds.add(tool.linked_task_id);
            return createAgentCallNode(childSubtaskByTaskId.get(tool.linked_task_id));
          }
          return createToolNode(tool);
        })
      };
      agentCallNode.children.push(reactNode);
    });
  }

  const directTools = (subtask.tool_calls || []).filter(tool => !tool?.call_id || !attachedToolIds.has(tool.call_id));
  directTools.forEach(tool => {
    if (tool.linked_task_id && childSubtaskByTaskId.has(tool.linked_task_id)) {
      agentCallNode.children.push(createAgentCallNode(childSubtaskByTaskId.get(tool.linked_task_id)));
      linkedChildIds.add(tool.linked_task_id);
    } else {
      agentCallNode.children.push(createToolNode(tool));
    }
  });

  sortSubtasks(subtask.children || []).forEach(child => {
    if (!linkedChildIds.has(child.task_id)) {
      agentCallNode.children.push(createAgentCallNode(child));
    }
  });

  return agentCallNode;
};

const hasThoughtContent = (step) => Boolean(step?.intent || step?.thinking || step?.thought);

const getDisplayExecutionStep = (steps = []) => {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return [...steps].reverse().find(hasThoughtContent) || null;
};

const getDisplayAgentStep = (steps = []) => {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return [...steps].reverse().find(step => step?.agent_display_name || step?.agent_name) || null;
};

const getLinkedSubtask = (tool, subtaskByTaskId) => {
  if (tool?.tool_name !== 'call_agent' || !tool?.linked_task_id) return null;
  return subtaskByTaskId.get(tool.linked_task_id) || null;
};

const appendRootChildren = (target, mergedToolCalls, rootSubtasks, subtaskByTaskId) => {
  const linkedSubtaskIds = new Set();
  mergedToolCalls.forEach(tool => {
    const linked = getLinkedSubtask(tool, subtaskByTaskId);
    if (linked) {
      target.push(createAgentCallNode(linked));
      linkedSubtaskIds.add(linked.task_id);
    } else {
      target.push(createToolNode(tool));
    }
  });
  rootSubtasks.forEach(subtask => {
    if (!linkedSubtaskIds.has(subtask.task_id)) {
      target.push(createAgentCallNode(subtask));
    }
  });
};

/**
 * @param {Array} executionSteps
 * @param {Array} subtasks
 * @returns {Array} TreeNode[]
 */
export function buildExecutionTree(executionSteps = [], subtasks = []) {
  const tree = [];

  const executionByRound = {};
  executionSteps.forEach(step => {
    const round = step.round || 1;
    if (!executionByRound[round]) executionByRound[round] = [];
    executionByRound[round].push(step);
  });

  const rootSubtasksByRound = {};
  subtasks.forEach(subtask => {
    const round = subtask.round || 1;
    if (!rootSubtasksByRound[round]) rootSubtasksByRound[round] = [];
    rootSubtasksByRound[round].push(subtask);
  });

  const allRounds = new Set([
    ...Object.keys(executionByRound).map(Number),
    ...Object.keys(rootSubtasksByRound).map(Number)
  ]);
  const sortedRounds = Array.from(allRounds).sort((a, b) => a - b);

  sortedRounds.forEach(round => {
    const executionStepsInRound = executionByRound[round] || [];
    const executionStep = getDisplayExecutionStep(executionStepsInRound);
    const displayAgentStep = getDisplayAgentStep(executionStepsInRound);
    const mergedToolCalls = executionStepsInRound.flatMap(step => (
      Array.isArray(step?.toolCalls) ? step.toolCalls : []
    ));
    const rootSubtasks = sortSubtasks(rootSubtasksByRound[round] || []);

    const subtaskByTaskId = new Map();
    rootSubtasks.forEach(subtask => subtaskByTaskId.set(subtask.task_id, subtask));

    if (!executionStep) {
      appendRootChildren(tree, mergedToolCalls, rootSubtasks, subtaskByTaskId);
      return;
    }

    const node = {
      type: 'thought',
      agent: displayAgentStep?.agent_name || executionStep?.agent_name || '',
      agent_display_name: displayAgentStep?.agent_display_name || displayAgentStep?.agent_name || executionStep?.agent_display_name || executionStep?.agent_name || 'orchestrator_agent',
      round,
      intent: executionStep.intent || executionStep.thinking || executionStep.thought || '',
      status: executionStep?.status || executionStep?.run_status || displayAgentStep?.status || displayAgentStep?.run_status || null,
      children: []
    };

    appendRootChildren(node.children, mergedToolCalls, rootSubtasks, subtaskByTaskId);
    tree.push(node);
  });

  return tree;
}
