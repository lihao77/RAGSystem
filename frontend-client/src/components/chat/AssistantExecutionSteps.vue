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
                :as-tail-output="tailActive && index === tailThoughtIndex"
                @notify="emit('notify', $event)"
                @citation-click="emit('citation-click', $event)"
              />
            </template>

            <div v-else-if="msg.executionStepsLoading" class="assistant-execution-state" role="status">
              <Spinner class="loading-spinner" aria-hidden="true" />
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
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useCollapsibleHeight } from '../../composables/useCollapsibleHeight.js';
import { buildExecutionTree } from '../../utils/executionTreeBuilder.js';
import { formatWorkDuration } from '../../utils/durationFormat.js';
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
// 扁平时间线：过程节点直接渲染，段尾最后的大模型输出（thought 尾轮）以 assistant
// 正文样式呈现（as-tail-output）——它可能是流式活跃轮，也可能是插嘴/中断留下的
// 未定格轮。final 毕业后轮 text 清空，最终答案由紧随的 assistant 消息行渲染。
const nodes = computed(() => buildExecutionTree(props.msg.executionTree));
const flatNodes = computed(() => flattenExecutionNodes(nodes.value));
const agentOperationCount = computed(() => flatNodes.value.filter(node => (
  node.type === 'tool_call' && node.tool_name === 'agent'
)).length);
const toolCount = computed(() => flatNodes.value.filter(node => (
  node.type === 'tool_call' && node.tool_name !== 'agent'
)).length);
// 过程入口的门控：树有节点 / 加载中 / 加载失败 / 历史未加载（此时入口行就是
// 懒加载触发器，必须在场——否则纯空树连点击加载的机会都没有）/ 用户点开过。
// 纯问答 run 加载后发现树为空：没点开过的段不加壳（入口缺席）；点开过的段
// 保留入口并显示"暂无执行步骤"，不在交互中原地消失。
const hasProcess = computed(() => Boolean(
  nodes.value.length
  || props.msg.executionStepsLoading
  || props.msg.executionStepsLoadError
  || msgIsUnloadedHistory.value
  || userRevealed.value,
));
// 运行态取自树根 agent 的生命周期——锚点消息自身的 finished 被 dispatcher
// 恒置 true，不能作为运行依据。插嘴被同 run 认领后，本段的 agent_ended 路由
// 到新边界面板，旧面板根 agent 停在 running——execution_superseded 让段已
// 结束，面板不再显示运行中。工具详情的“执行中”以节点自身 status 为准，
// 此 run 级标志只做门控（见 AssistantToolCallDetail）。
const root = computed(() => props.msg.executionTree?.root || null);
const running = computed(() => root.value?.status === 'running'
  && props.msg.execution_superseded !== true);
const msgIsUnloadedHistory = computed(() => Boolean(
  props.msg.has_execution
  && !props.msg.executionTree?.root
  && !props.msg.executionStepsLoaded,
));
// 用户点开过的段（手动展开）：历史懒加载后发现树为空也不移除面板，
// 展开态显示"暂无执行步骤"兜底；未点开过的段保持无入口（不加壳）。
const userRevealed = ref(false);

/* 段尾输出（该段最后的大模型文字，assistant 姿态呈现）：
   - 流式中：树尾活跃轮 text——它就是候选最终答案；
   - 插嘴孤儿段（execution_superseded）/ 中断、失败段：未定格的半截轮 text，
     该段永远等不到自己的 final，它就是段内最后的输出；
   - 正常完成段：final 毕业清空轮 text，段尾输出自然缺席，最终答案由紧随的
     assistant 消息行渲染（不重复出现）。 */
const tailActive = computed(() => running.value
  || props.msg.execution_superseded === true
  || root.value?.status === 'interrupted'
  || root.value?.status === 'failed');
const tailThoughtIndex = computed(() => {
  for (let index = nodes.value.length - 1; index >= 0; index -= 1) {
    const node = nodes.value[index];
    if (node?.type === 'thought' && (node.intent || '').trim()) return index;
  }
  return -1;
});

/* 工作时长：优先协议投影的 root.startedAt/endedAt（envelope 顶层 timestamp）；
   事件缺时间戳（旧后端/AG-UI 降级通道）时用前端首次见到 running 的本地时刻兜底，
   终态且无协议时间则无时长（降级为仅计数摘要）。 */
const now = ref(Date.now());
const localStartAt = ref(0);
let elapsedTimer = 0;

const elapsedMs = computed(() => {
  const start = root.value?.startedAt || localStartAt.value;
  if (!start) return null;
  if (running.value) return Math.max(0, now.value - start);
  const end = root.value?.endedAt;
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
});
const durationText = computed(() => formatWorkDuration(elapsedMs.value ?? Number.NaN));

const headerLabel = computed(() => {
  if (msgIsUnloadedHistory.value || !flatNodes.value.length) return '执行过程';
  const labels = [];
  if (durationText.value) labels.push(`已工作 ${durationText.value}`);
  if (toolCount.value) labels.push(`${toolCount.value} 个工具调用`);
  if (agentOperationCount.value) labels.push(`${agentOperationCount.value} 个智能体操作`);
  return labels.join(' · ') || '执行过程';
});

function restartElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = 0;
  }
  if (!running.value) return;
  elapsedTimer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
}

// 初始值取当前运行态：挂载时 run 已在进行（刷新/重连 mid-run），面板直接展开，
// 不依赖 watch 边沿触发。
const expanded = ref(running.value);

// 运行开始自动展开过程（看它干活），run 级终态自动收起——折叠触发绑 run 终态
// 而非轮级 final：插嘴孤儿段/被 followup 打断的轮可能永远等不到 final。收起后
// 段尾输出（若段无 final 正文）保持展开，时间线仍是 用户消息→段尾输出 的节奏。
// 只在"开始/结束"边沿触发，不拦截用户在运行中的手动展开/收起。
watch(running, (isRunning) => {
  expanded.value = isRunning;
  if (isRunning && !localStartAt.value) localStartAt.value = Date.now();
  if (!isRunning) localStartAt.value = 0;
  now.value = Date.now();
  restartElapsedTimer();
}, { immediate: true });

watch(() => props.msg.run_id || props.msg.id, () => {
  expanded.value = false;
  localStartAt.value = 0;
});

onBeforeUnmount(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
});

async function toggleExpanded() {
  if (expanded.value) {
    expanded.value = false;
    return;
  }
  // 点开即认领：加载后即使树为空，面板也在场显示"暂无执行步骤"。
  userRevealed.value = true;
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

/* 面板高度动画：内容无上限，max-height 由 useCollapsibleHeight 以实测值驱动（展开后
   解除上限，流式节点增长不被裁剪）。 */
const listOuter = ref(null);
useCollapsibleHeight(listOuter, expanded);

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
  margin-top: 6px;
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

/* 加载态 spinner 与步骤行图标同格（14×14，覆盖 size-4 的 16px），图标列宽一致。 */
.assistant-execution-state :deep(.loading-spinner) {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
}

@media (prefers-reduced-motion: reduce) {
  .assistant-execution-list-outer,
  .assistant-execution-chevron {
    transition-duration: 1ms;
  }
}
</style>
