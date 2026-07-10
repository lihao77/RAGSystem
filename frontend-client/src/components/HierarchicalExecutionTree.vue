<template>
  <div class="execution-tree">
    <div class="tree-header">
      <span class="tree-title">
        <span>执行过程</span>
      </span>
    </div>

    <div class="tree-container">
      <ExecutionTimelineNode
        v-for="(node, index) in executionTreeNodes"
        :key="getExecutionNodeKey(node) || index"
        :node="node"
        :depth="0"
        :session-id="sessionId"
      />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import ExecutionTimelineNode from './workpanel/ExecutionTimelineNode.vue';
import { buildExecutionTree } from '../utils/executionTreeBuilder';
import { getExecutionNodeKey } from '../utils/executionTreePresentation';

const props = defineProps({
  executionTree: { type: Object, default: () => ({ root: null, steps: [] }) },
  /** 本 run 的注入消息(followup/后台通知),挂进 tree 作 injection 节点。 */
  injections: { type: Array, default: () => [] },
  sessionId: { type: String, default: '' }
});

const executionTreeNodes = computed(() =>
  buildExecutionTree(props.executionTree, props.injections)
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
  --rail-width: 22px;
  --rail-dot-top: 17px;
  --rail-dot-size: 9px;
  --rail-dot-center: calc(var(--rail-dot-top) + (var(--rail-dot-size) / 2));
  --timeline-rail-thickness: 2px;
  display: flex;
  flex-direction: column;
  position: relative;
}

.tree-container::before {
  content: '';
  position: absolute;
  left: calc((var(--rail-width) - var(--timeline-rail-thickness)) / 2);
  top: var(--rail-dot-center);
  bottom: 0;
  width: var(--timeline-rail-thickness);
  border-radius: var(--radius-full);
  background: var(--color-border);
  opacity: 0.7;
  pointer-events: none;
}
</style>
