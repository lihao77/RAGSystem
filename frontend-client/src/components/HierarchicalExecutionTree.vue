<template>
  <div class="execution-tree">
    <div class="tree-header">
      <span class="tree-title">
        <span>执行过程</span>
      </span>
    </div>

    <div class="tree-container">
      <ExecutionNode
        v-for="(node, index) in executionTree"
        :key="index"
        :node="node"
        :level="0"
        :session-id="sessionId"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, defineProps } from 'vue';
import ExecutionNode from './ExecutionNode.vue';

const props = defineProps({
  executionSteps: {
    type: Array,
    default: () => []
  },
  subtasks: {
    type: Array,
    default: () => []
  },
  sessionId: {
    type: String,
    default: ''
  }
});

const createToolNode = (tool) => ({
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
  expanded: tool.expanded || false
});

const sortSubtasks = (subtasks = []) => [...subtasks].sort((a, b) => {
  const aIndex = a?.round_index ?? Number.MAX_SAFE_INTEGER;
  const bIndex = b?.round_index ?? Number.MAX_SAFE_INTEGER;
  if (aIndex !== bIndex) return aIndex - bIndex;
  const aOrder = a?.order ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b?.order ?? Number.MAX_SAFE_INTEGER;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return String(a?.task_id || '').localeCompare(String(b?.task_id || ''));
});

const createAgentCallNode = (subtask) => {
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

  const attachedToolIds = new Set();
  if (subtask.react_steps && subtask.react_steps.length > 0) {
    subtask.react_steps.forEach(reactStep => {
      const reactTools = Array.isArray(reactStep.toolCalls) ? reactStep.toolCalls : [];
      reactTools.forEach(tool => {
        if (tool?.call_id) attachedToolIds.add(tool.call_id);
      });

      const hasIntent = Boolean(reactStep.intent || reactStep.thinking || reactStep.thought);
      if (!hasIntent) {
        reactTools.forEach(tool => {
          agentCallNode.children.push(createToolNode(tool));
        });
        return;
      }

      const reactNode = {
        type: 'thought',
        agent: subtask.agent_name,
        agent_display_name: subtask.agent_display_name,
        round: reactStep.round,
        intent: reactStep.intent || reactStep.thinking || reactStep.thought || '',
        children: reactTools.map(createToolNode)
      };
      agentCallNode.children.push(reactNode);
    });
  }

  const directTools = (subtask.tool_calls || []).filter(tool => !tool?.call_id || !attachedToolIds.has(tool.call_id));
  directTools.forEach(tool => {
    agentCallNode.children.push(createToolNode(tool));
  });

  sortSubtasks(subtask.children || []).forEach(child => {
    agentCallNode.children.push(createAgentCallNode(child));
  });

  return agentCallNode;
};

const hasThoughtContent = (step) => Boolean(
  step?.intent || step?.thinking || step?.thought
);

const getDisplayExecutionStep = (steps = []) => {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return [...steps].reverse().find(hasThoughtContent) || null;
};

const getDisplayAgentStep = (steps = []) => {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return [...steps].reverse().find(step => step?.agent_display_name || step?.agent_name) || null;
};

const executionTree = computed(() => {
  const tree = [];
  const executionSteps = props.executionSteps || [];
  const subtasks = props.subtasks || [];

  const executionByRound = {};
  executionSteps.forEach(step => {
    const round = step.round || 1;
    if (!executionByRound[round]) {
      executionByRound[round] = [];
    }
    executionByRound[round].push(step);
  });

  const rootSubtasksByRound = {};
  subtasks.forEach(subtask => {
    const round = subtask.round || 1;
    if (!rootSubtasksByRound[round]) {
      rootSubtasksByRound[round] = [];
    }
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

    const hasVisibleOrchestratorContent = Boolean(
      executionStep || mergedToolCalls.length > 0
    );

    if (!hasVisibleOrchestratorContent) {
      rootSubtasks.forEach(subtask => {
        tree.push(createAgentCallNode(subtask));
      });
      return;
    }

    const node = {
      type: 'thought',
      agent: displayAgentStep?.agent_name || executionStep?.agent_name || '',
      agent_display_name: displayAgentStep?.agent_display_name || displayAgentStep?.agent_name || executionStep?.agent_display_name || executionStep?.agent_name || 'orchestrator_agent',
      round: round,
      intent: executionStep ? (executionStep.intent || executionStep.thinking || executionStep.thought || '') : '',
      status: executionStep?.status || executionStep?.run_status || displayAgentStep?.status || displayAgentStep?.run_status || null,
      children: []
    };

    mergedToolCalls.forEach(tool => {
      node.children.push(createToolNode(tool));
    });

    rootSubtasks.forEach(subtask => {
      node.children.push(createAgentCallNode(subtask));
    });

    tree.push(node);
  });

  return tree;
});
</script>

<style scoped>
.execution-tree {
  padding: var(--spacing-md) 0;
  font-family: var(--font-sans);
}

.tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-md);
  padding: 0 var(--spacing-xs);
}

.tree-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  letter-spacing: -0.01em;
}

.tree-container {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}
</style>
