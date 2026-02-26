<template>
  <div class="execution-tree">
    <div class="tree-header">
      <span class="tree-title">
        <span class="pulse-icon">🧠</span>
        <span>执行过程</span>
      </span>
    </div>

    <div class="tree-container">
      <ExecutionNode
        v-for="(node, index) in executionTree"
        :key="index"
        :node="node"
        :level="0"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, defineProps } from 'vue';
import ExecutionNode from './ExecutionNode.vue';

const props = defineProps({
  masterSteps: {
    type: Array,
    default: () => []
  },
  subtasks: {
    type: Array,
    default: () => []
  }
});

/**
 * 将 master_steps 和 subtasks 合并为层次化的执行树
 *
 * 核心逻辑：
 * 1. Master 的每个 thought 作为根节点（按 round）
 * 2. 同一 round 的 subtasks 作为该 thought 的子节点
 * 3. subtask 内部的 react_steps 递归嵌套
 */
const executionTree = computed(() => {
  const tree = [];
  const masterSteps = props.masterSteps || [];
  const subtasks = props.subtasks || [];

  // 按 round 分组
  const masterByRound = {};
  masterSteps.forEach(step => {
    const round = step.round || 1;
    if (!masterByRound[round]) {
      masterByRound[round] = step;
    }
  });

  const subtasksByRound = {};
  subtasks.forEach(subtask => {
    const round = subtask.round || 1;
    if (!subtasksByRound[round]) {
      subtasksByRound[round] = [];
    }
    subtasksByRound[round].push(subtask);
  });

  // 获取所有 round 并排序
  const allRounds = new Set([
    ...Object.keys(masterByRound).map(Number),
    ...Object.keys(subtasksByRound).map(Number)
  ]);
  const sortedRounds = Array.from(allRounds).sort((a, b) => a - b);

  // 构建树
  sortedRounds.forEach(round => {
    const masterStep = masterByRound[round];
    const subtasksInRound = subtasksByRound[round] || [];

    // 创建 Master thought 节点
    const node = {
      type: 'thought',
      agent: 'master_agent_v2',
      agent_display_name: 'Master Agent',
      round: round,
      thought: masterStep ? (masterStep.thought || '') : '',
      children: []
    };

    // 添加 Master 的工具调用
    if (masterStep && masterStep.toolCalls && masterStep.toolCalls.length > 0) {
      masterStep.toolCalls.forEach(tool => {
        node.children.push({
          type: 'tool_call',
          tool_name: tool.tool_name,
          arguments: tool.arguments,
          result: tool.result,
          status: tool.status,
          elapsed_time: tool.elapsed_time,
          expanded: tool.expanded || false
        });
      });
    }

    // 添加该轮次的子任务
    subtasksInRound.forEach(subtask => {
      const agentCallNode = {
        type: 'agent_call',
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

      // 添加子任务的 ReAct 步骤
      if (subtask.react_steps && subtask.react_steps.length > 0) {
        subtask.react_steps.forEach(reactStep => {
          const reactNode = {
            type: 'thought',
            agent: subtask.agent_name,
            agent_display_name: subtask.agent_display_name,
            round: reactStep.round,
            thought: reactStep.thought || '',
            children: []
          };

          // 添加该 ReAct 步骤的工具调用
          if (reactStep.toolCalls && reactStep.toolCalls.length > 0) {
            reactStep.toolCalls.forEach(tool => {
              reactNode.children.push({
                type: 'tool_call',
                tool_name: tool.tool_name,
                arguments: tool.arguments,
                result: tool.result,
                status: tool.status,
                elapsed_time: tool.elapsed_time,
                expanded: tool.expanded || false
              });
            });
          }

          agentCallNode.children.push(reactNode);
        });
      }

      node.children.push(agentCallNode);
    });

    tree.push(node);
  });

  return tree;
});
</script>

<style scoped>
.execution-tree {
  padding: var(--spacing-lg) 0;
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
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.pulse-icon {
  font-size: 1.1rem;
  opacity: 0.9;
}

.tree-container {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}
</style>
