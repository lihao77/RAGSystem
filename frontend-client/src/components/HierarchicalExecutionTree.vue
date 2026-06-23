<template>
  <div class="execution-tree">
    <div class="tree-header">
      <span class="tree-title">
        <span>执行过程</span>
      </span>
    </div>

    <div class="tree-container">
      <ExecutionNode
        v-for="(node, index) in executionTreeNodes"
        :key="index"
        :node="node"
        :level="0"
        :session-id="sessionId"
      />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import ExecutionNode from './ExecutionNode.vue';
import { buildExecutionTree } from '../utils/executionTreeBuilder';

const props = defineProps({
  executionTree: { type: Object, default: () => ({ root: null, steps: [] }) },
  sessionId: { type: String, default: '' }
});

const executionTreeNodes = computed(() =>
  buildExecutionTree(props.executionTree)
);
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
  letter-spacing: 0;
}

.tree-container {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}
</style>
