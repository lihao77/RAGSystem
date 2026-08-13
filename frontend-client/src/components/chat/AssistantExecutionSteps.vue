<template>
  <div class="assistant-execution">
    <Button
      class="assistant-execution-toggle"
      variant="bare"
      type="button"
      :aria-expanded="expanded"
      :title="expanded ? '收起执行步骤' : '展开执行步骤'"
      @click="toggleExpanded"
    >
      <span class="assistant-execution-label">{{ headerLabel }}</span>
      <span v-if="running" class="assistant-execution-running">运行中</span>
      <ChevronDown
        class="assistant-execution-chevron"
        :class="{ open: expanded }"
        aria-hidden="true"
      />
    </Button>

    <div class="assistant-execution-list-outer" :class="{ 'is-open': expanded }">
      <div class="assistant-execution-list-clip">
        <div class="assistant-execution-list">
        <template v-if="nodes.length">
          <AssistantExecutionNode
            v-for="(node, index) in nodes"
            :key="nodeKey(node, index)"
            :node="node"
            :running="running"
            @notify="emit('notify', $event)"
            @citation-click="emit('citation-click', $event)"
          />
        </template>

        <div v-else-if="msg.executionStepsLoading" class="assistant-execution-state" role="status">
          <Spinner aria-hidden="true" />
          <span>正在加载执行步骤...</span>
        </div>

        <Button
          v-else-if="msg.executionStepsLoadError"
          class="self-start"
          variant="ghost"
          size="sm"
          type="button"
          @click="loadHistoricalSteps"
        >
          加载失败，点击重试
        </Button>

        <span v-else class="assistant-execution-state">暂无执行步骤</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ChevronDown } from 'lucide-vue-next';
import { computed, inject, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { buildExecutionTree } from '../../utils/executionTreeBuilder.js';
import {
  flattenExecutionNodes,
  getExecutionNodeKey,
} from '../../utils/executionTreePresentation.js';
import AssistantExecutionNode from './AssistantExecutionNode.vue';

const props = defineProps({
  msg: { type: Object, required: true },
});

const emit = defineEmits(['notify', 'citation-click']);
const messageContext = inject('messageContext');
const nodes = computed(() => buildExecutionTree(props.msg.executionTree));
const flatNodes = computed(() => flattenExecutionNodes(nodes.value));
const toolCount = computed(() => flatNodes.value.filter(node => node.type === 'tool_call').length);
const hasFinalAnswer = computed(() => Boolean(
  props.msg.content?.trim()
  || props.msg.content_parts?.some(part => (
    part?.type === 'file_ref'
    || (part?.type === 'text' && part.text?.trim())
  )),
));
const finalVisible = computed(() => Boolean(props.msg.finished && hasFinalAnswer.value));
const expanded = ref(false);
const running = computed(() => !props.msg.finished && !props.msg.stopped);
const msgIsUnloadedHistory = computed(() => Boolean(
  props.msg.has_execution
  && !props.msg.executionTree?.root
  && !props.msg.executionStepsLoaded,
));
const headerLabel = computed(() => {
  if (msgIsUnloadedHistory.value || !flatNodes.value.length) return '执行步骤';
  return `${toolCount.value} 个工具调用`;
});

watch(finalVisible, (visible, wasVisible) => {
  if (visible && !wasVisible) expanded.value = false;
});

watch(() => props.msg.run_id || props.msg.id, () => {
  expanded.value = false;
});

async function toggleExpanded() {
  expanded.value = !expanded.value;
  if (expanded.value) await loadHistoricalSteps();
}

async function loadHistoricalSteps() {
  if (!msgIsUnloadedHistory.value || props.msg.executionStepsLoading) return;
  try {
    await messageContext?.ensureExecutionStepsLoaded?.(props.msg);
  } catch {
    // 错误状态由 message 自身承载，保留展开态以展示重试入口。
  }
}

function nodeKey(node, index) {
  return getExecutionNodeKey(node) || `${node.type || 'step'}-${index}`;
}

</script>

<style scoped>
.assistant-execution {
  display: flex;
  align-self: flex-start;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.assistant-execution-toggle {
  align-self: flex-start;
  width: auto;
  height: auto;
  min-height: 0;
  justify-content: flex-start;
  gap: 6px;
  padding: 2px 0;
  font-size: 12.5px;
  line-height: 1.5;
}

.assistant-execution-label {
  font-weight: 500;
}

.assistant-execution-running {
  color: var(--color-brand-accent);
  font-size: 11px;
}

.assistant-execution-chevron {
  transition: transform var(--transition-fast);
}

.assistant-execution-chevron.open {
  transform: rotate(180deg);
}

.assistant-execution-list-outer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 240ms var(--ease-out-expo, ease);
}

.assistant-execution-list-outer.is-open {
  grid-template-rows: 1fr;
}

.assistant-execution-list-clip {
  min-height: 0;
  overflow: hidden;
}

.assistant-execution-list {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding-bottom: 6px;
}

.assistant-execution-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-block: 3px;
  color: var(--color-text-muted);
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .assistant-execution-list-outer,
  .assistant-execution-chevron {
    transition-duration: 1ms;
  }
}
</style>
