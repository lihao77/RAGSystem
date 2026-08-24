<template>
  <div class="assistant-execution">
    <template v-if="hasProcess">
      <Button
        class="assistant-execution-toggle"
        variant="bare"
        type="button"
        :aria-expanded="expanded"
        :title="expanded ? '收起执行过程' : '展开执行过程'"
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
    </template>
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
// 树只承载过程（思考/意图/工具/注入）；最终答案由消息槽 assistant 行渲染。
const nodes = computed(() => buildExecutionTree(props.msg.executionTree));
const flatNodes = computed(() => flattenExecutionNodes(nodes.value));
const agentOperationCount = computed(() => flatNodes.value.filter(node => (
  node.type === 'tool_call' && node.tool_name === 'agent'
)).length);
const toolCount = computed(() => flatNodes.value.filter(node => (
  node.type === 'tool_call' && node.tool_name !== 'agent'
)).length);
// 过程入口的门控：树有节点 / 加载中 / 加载失败 / 历史未加载（此时入口行就是
// 懒加载触发器，必须在场——否则纯空树连点击加载的机会都没有）。
// 纯问答 run 加载后发现树为空，入口自然消失（不加壳）。
const hasProcess = computed(() => Boolean(
  nodes.value.length
  || props.msg.executionStepsLoading
  || props.msg.executionStepsLoadError
  || msgIsUnloadedHistory.value,
));
// 运行态取自树根 agent 的生命周期——锚点消息自身的 finished 被 dispatcher
// 恒置 true，不能作为运行依据。插嘴被同 run 认领后，本段的 agent_ended 路由
// 到新边界面板，旧面板根 agent 停在 running——execution_superseded 让段已
// 结束，面板不再显示运行中（工具详情的“执行中”同源于此）。
const running = computed(() => props.msg.executionTree?.root?.status === 'running'
  && props.msg.execution_superseded !== true);
const msgIsUnloadedHistory = computed(() => Boolean(
  props.msg.has_execution
  && !props.msg.executionTree?.root
  && !props.msg.executionStepsLoaded,
));
const headerLabel = computed(() => {
  if (msgIsUnloadedHistory.value || !flatNodes.value.length) return '执行过程';
  const labels = [];
  if (toolCount.value) labels.push(`${toolCount.value} 个工具调用`);
  if (agentOperationCount.value) labels.push(`${agentOperationCount.value} 个智能体操作`);
  return labels.join(' · ') || '执行过程';
});

const expanded = ref(false);

// 运行开始自动展开过程（看它干活），运行结束自动收起（答案由下方 assistant 消息槽
// 呈现，过程收起后时间线仍是 用户消息→答案 的节奏）。只在"开始/结束"边沿触发，
// 不拦截用户在运行中的手动展开/收起。
watch(running, (isRunning) => {
  expanded.value = isRunning;
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
