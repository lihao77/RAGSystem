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

    <div ref="listOuter" class="assistant-execution-list-outer" :class="{ 'is-open': expanded }">
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
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
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
const agentOperationCount = computed(() => flatNodes.value.filter(node => (
  node.type === 'tool_call' && node.tool_name === 'agent'
)).length);
const toolCount = computed(() => flatNodes.value.filter(node => (
  node.type === 'tool_call' && node.tool_name !== 'agent'
)).length);
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
  const labels = [];
  if (toolCount.value) labels.push(`${toolCount.value} 个工具调用`);
  if (agentOperationCount.value) labels.push(`${agentOperationCount.value} 个智能体操作`);
  return labels.join(' · ') || '执行步骤';
});

watch(finalVisible, (visible, wasVisible) => {
  if (visible && !wasVisible) expanded.value = false;
});

watch(() => props.msg.run_id || props.msg.id, () => {
  expanded.value = false;
});

async function toggleExpanded() {
  if (expanded.value) {
    expanded.value = false;
    return;
  }
  // 历史步骤未就绪时先取完整数据再展开，避免先开占位面板、数据到达后再跳变。
  if (msgIsUnloadedHistory.value || props.msg.executionStepsLoading) {
    await loadHistoricalSteps();
    await waitForStepsSettled();
  }
  expanded.value = true;
}

/** 等在途的步骤加载落地（并发触发时 loadHistoricalSteps 会直接返回）。 */
function waitForStepsSettled() {
  if (!props.msg.executionStepsLoading) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(() => props.msg.executionStepsLoading, (loading) => {
      if (!loading) {
        stop();
        resolve();
      }
    });
  });
}

/* 面板高度动画：内容无上限，max-height 用实测值驱动（展开后解除上限，
   流式节点增长不被裁剪）。不用 grid 0fr/1fr——Chrome 在 fr 过渡期对 item 的
   stretch 解析有缺陷，动画过程中容器占位与实际内容之间会出现空白。 */
const listOuter = ref(null);
let heightReleaseTimer = 0;

watch(expanded, (open) => {
  nextTick(() => syncPanelHeight(open));
});

onBeforeUnmount(() => {
  window.clearTimeout(heightReleaseTimer);
});

function syncPanelHeight(open) {
  const el = listOuter.value;
  if (!el) return;
  window.clearTimeout(heightReleaseTimer);
  if (open) {
    el.style.maxHeight = `${el.scrollHeight}px`;
    scheduleHeightRelease(el);
  } else {
    if (el.style.maxHeight === 'none') {
      el.style.maxHeight = `${el.scrollHeight}px`;
      void el.offsetHeight;
    }
    el.style.maxHeight = '0px';
  }
}

function scheduleHeightRelease(el) {
  heightReleaseTimer = window.setTimeout(() => {
    if (expanded.value) el.style.maxHeight = 'none';
  }, 260);
}

/* 展开期间内容变化（历史步骤加载完成 / 流式新增节点）：上限仍钉在旧值时
   平滑过渡到新高度，避免释放后从占位高度直接跳变到完整高度。 */
watch(nodes, () => {
  if (!expanded.value) return;
  const el = listOuter.value;
  if (!el || el.style.maxHeight === 'none') return;
  el.style.maxHeight = `${el.scrollHeight}px`;
  scheduleHeightRelease(el);
});

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
  max-height: 0;
  overflow: hidden;
  transition: max-height 180ms linear;
}

.assistant-execution-list-outer.is-open {
  transition: max-height 240ms linear;
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
