<template>
  <!-- 渲染一层兄弟节点:经 buildActionRows 把连续同类工具折叠成组,
       其余按类型分发到 ThoughtRow / ActionRow / 递归 TimelineNode。 -->
  <div class="enr">
    <template v-for="row in rows" :key="rowKey(row)">
      <!-- 折叠组 -->
      <div v-if="row.kind === 'group'" class="enr-group">
        <ExecutionActionRow
          :group="row"
          :depth="depth"
          :expanded="isGroupExpanded(row)"
          @toggle="toggleGroup(row)"
        />
        <div class="enr-group-body" :class="{ 'is-open': isGroupExpanded(row) }">
          <div class="enr-group-inner">
            <ExecutionActionRow
              v-for="(child, i) in row.nodes"
              :key="childKey(child, i)"
              :node="child"
              :depth="depth + 1"
              :selected-key="selectedKey"
              @inspect="emit('inspect', $event)"
            />
          </div>
        </div>
      </div>

      <!-- agent_call / thought:都可能有子树,走 TimelineNode 统一编排
           (thought 内部渲染 ThoughtRow 头 + 恒可见工具流;agent 渲染 ActionRow 头 + 可折叠子树) -->
      <ExecutionTimelineNode
        v-else-if="row.node.type === 'agent_call' || row.node.type === 'thought'"
        :node="row.node"
        :depth="depth"
        :session-id="sessionId"
        :focus-key="focusKey"
        :selected-key="selectedKey"
        :expanded-groups="expandedGroups"
        @inspect="emit('inspect', $event)"
        @toggle-group="emit('toggleGroup', $event)"
        @layout-change="emit('layoutChange')"
      />

      <!-- tool / injection / 其它叶子 -->
      <ExecutionActionRow
        v-else
        :node="row.node"
        :depth="depth"
        :selected-key="selectedKey"
        @inspect="emit('inspect', $event)"
      />
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import {
  buildActionRows,
  getExecutionNodeKey as getNodeKey,
} from '../../utils/executionTreePresentation'
import ExecutionActionRow from './ExecutionActionRow.vue'
import ExecutionTimelineNode from './ExecutionTimelineNode.vue'

defineOptions({ name: 'ExecutionNodeRows' })

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  depth: { type: Number, default: 0 },
  sessionId: { type: String, default: '' },
  focusKey: { type: String, default: '' },
  selectedKey: { type: String, default: '' },
  expandedGroups: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['inspect', 'toggleGroup', 'layoutChange'])

const rows = computed(() => buildActionRows(props.nodes))

function isGroupExpanded(row) {
  return Boolean(props.expandedGroups[groupId(row)])
}

function toggleGroup(row) {
  emit('toggleGroup', groupId(row))
}

function groupId(row) {
  return `${row.groupKey}:${firstKey(row.nodes)}`
}

function firstKey(nodes) {
  return nodes && nodes.length ? getNodeKey(nodes[0]) : ''
}

function rowKey(row) {
  if (row.kind === 'group') return `group:${groupId(row)}`
  return getNodeKey(row.node)
}

function childKey(node, index) {
  return getNodeKey(node) || `child-${index}`
}
</script>

<style scoped>
.enr {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.enr-group {
  position: relative;
}

/* grid 0fr→1fr 实现高度自适应展开,无需 JS 测量,不受 content-visibility 影响。 */
.enr-group-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows var(--duration-base, 220ms) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)),
    opacity 160ms ease;
}

.enr-group-body.is-open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.enr-group-inner {
  min-height: 0;
  overflow: hidden;
  /* 竖线对齐组头 svg 图标中心(13px),与子树几何一致 */
  margin-left: 13px;
  padding-left: 12px;
  border-left: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.enr-group-body.is-open .enr-group-inner {
  padding-top: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .enr-group-body {
    transition-duration: 1ms;
  }
}
</style>
