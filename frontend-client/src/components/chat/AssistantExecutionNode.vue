<template>
  <div class="assistant-step-node">
    <template v-if="node.type === 'reasoning'">
      <button
        type="button"
        class="assistant-step-row"
        :class="{ 'status-running': reasoningStreaming }"
        :style="indentStyle"
        :aria-expanded="reasoningExpanded"
        @click="toggleReasoningExpanded"
      >
        <span class="assistant-step-icon" title="思考过程">
          <Brain aria-hidden="true" />
        </span>
        <span class="assistant-step-name" :class="{ 'is-shimmer': reasoningStreaming }">深度思考</span>
        <span v-if="reasoningStreaming" class="assistant-step-summary">思考中...</span>
        <ChevronDown class="assistant-step-chevron" :class="{ open: reasoningExpanded }" aria-hidden="true" />
      </button>
      <div
        class="assistant-step-reasoning-wrap"
        :class="{
          'is-open': reasoningExpanded,
          'is-scrolled-top': reasoningTopFaded,
          'is-scrolled-bottom': reasoningBottomFaded,
        }"
        :style="reasoningLineStyle"
      >
        <div ref="reasoningClipEl" class="assistant-step-reasoning-clip">
          <div
            ref="reasoningEl"
            class="assistant-step-reasoning"
            :style="detailIndentStyle"
            @scroll.passive="handleReasoningScroll"
            @wheel.passive="handleReasoningWheel"
          >
            <div ref="reasoningTextEl" class="assistant-step-reasoning-text"></div>
          </div>
        </div>
        <div class="assistant-step-reasoning-fade is-bottom" aria-hidden="true"></div>
      </div>
    </template>

    <template v-else-if="node.type === 'thought'">
      <!-- 段尾输出：该段最后的大模型文字（流式活跃轮/插嘴或中断的未定格轮），
           以 assistant 正文姿态呈现——不可折叠 + 流式光标；排版与 intent/最终
           答案行同款（见样式），降级时不发生缩放跳动。 -->
      <div v-if="asTailOutput" class="assistant-step-tail-output">
        <MessageContentParts
          v-if="node.text_parts?.length"
          :parts="node.text_parts"
          :msg="tailMsgProxy"
          @notify="emit('notify', $event)"
          @citation-click="emit('citation-click', $event)"
        />
        <MarkdownContent
          v-else
          :content="node.intent || ''"
          :streaming="tailStreaming"
          @notify="emit('notify', $event)"
          @citation-click="emit('citation-click', $event)"
        />
      </div>
      <div v-else class="assistant-step-intent" :style="indentStyle">
        <MarkdownContent
          :content="node.intent || ''"
          :streaming="running && node.intent_complete === false"
          @notify="emit('notify', $event)"
          @citation-click="emit('citation-click', $event)"
        />
      </div>
      <!-- 子步骤统一挂在文本容器外：段尾输出降级为 intent 时 children 不换容器，
           几何不变。 -->
      <div v-if="hasChildren" class="assistant-step-children">
        <AssistantExecutionNode
          v-for="(child, index) in node.children"
          :key="nodeKey(child, index)"
          :node="child"
          :depth="depth"
          :running="running"
          @notify="emit('notify', $event)"
          @citation-click="emit('citation-click', $event)"
        />
      </div>
    </template>

    <template v-else>
      <button
        type="button"
        class="assistant-step-row"
        :class="[`status-${status}`, { 'is-agent': isAgentNode }]"
        :style="[indentStyle, isAgentNode ? { '--agent-accent': agentAccent } : null]"
        :aria-expanded="expandable ? expanded : undefined"
        @click="toggleExpanded"
      >
        <span class="assistant-step-icon" :title="iconLabel">
          <WorkPanelTimelineIcon :kind="iconKind" />
        </span>
        <span class="assistant-step-name" :class="{ 'is-shimmer': status === 'running' }">{{ titleText }}</span>
        <span v-if="summaryText" class="assistant-step-summary">{{ summaryText }}</span>
        <ChevronDown
          v-if="expandable"
          class="assistant-step-chevron"
          :class="{ open: expanded }"
          aria-hidden="true"
        />
      </button>

      <div v-if="hasDetails" ref="detailWrapEl" class="assistant-step-detail-wrap" :class="{ 'is-open': expanded }">
        <div class="assistant-step-detail" :style="detailIndentStyle">
          <AssistantToolCallDetail
            v-if="node.type === 'tool_call'"
            :node="node"
            :running="running"
            @notify="emit('notify', $event)"
          />

          <template v-else>
            <div v-if="detailTask" class="assistant-step-detail-block">
              <span class="assistant-step-detail-label">任务</span>
              <div class="assistant-step-detail-text">{{ detailTask }}</div>
            </div>
            <div v-if="detailResult" class="assistant-step-detail-block">
              <span class="assistant-step-detail-label">结果</span>
              <div class="assistant-step-detail-text" :class="{ 'is-error': status === 'error' }">
                {{ detailResult }}
              </div>
            </div>
          </template>
        </div>
      </div>

      <div v-if="hasChildren" ref="childWrapEl" class="assistant-step-child-wrap" :class="{ 'is-open': expanded }">
        <AssistantExecutionNode
          v-for="(child, index) in node.children"
          :key="nodeKey(child, index)"
          :node="child"
          :depth="depth + 1"
          :running="running"
          @notify="emit('notify', $event)"
          @citation-click="emit('citation-click', $event)"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { Brain, ChevronDown } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import WorkPanelTimelineIcon from '../workpanel/WorkPanelTimelineIcon.vue';
import {
  getToolDisplayName,
  getToolIconKind,
  getToolSubtitle,
} from '../../utils/toolPresentation.js';
import {
  getExecutionNodeKey,
  normalizeExecutionStatus,
} from '../../utils/executionTreePresentation.js';
import { getAgentOperationTitle } from '../../utils/executionTreeBuilder.js';
import { agentNodeAccentColor } from '../../utils/participantVisual.js';
import { useCollapsibleHeight } from '../../composables/useCollapsibleHeight.js';
import AssistantToolCallDetail from './AssistantToolCallDetail.vue';
import MarkdownContent from './MarkdownContent.vue';
import MessageContentParts from './MessageContentParts.vue';

defineOptions({ name: 'AssistantExecutionNode' });

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  running: { type: Boolean, default: false },
  // 段尾输出标记：本节点是段内最后的大模型文字，切换为 assistant 正文姿态。
  asTailOutput: { type: Boolean, default: false },
});

const emit = defineEmits(['notify', 'citation-click']);
const expanded = ref(false);
const tailStreaming = computed(() => props.running && props.node.intent_complete === false);
// MessageContentParts 的流式光标由 msg.finished/stopped 驱动，段尾输出用本节点
// 的流式态代理（不走消息槽——段尾输出可能永远没有对应消息行）。
const tailMsgProxy = computed(() => ({ finished: !tailStreaming.value, stopped: false }));
const status = computed(() => normalizeExecutionStatus(props.node.status));
const isAgentOperation = computed(() => props.node.type === 'tool_call' && props.node.tool_name === 'agent');
const isAgentNode = computed(() => props.node.type === 'agent_call' || isAgentOperation.value);
const hasChildren = computed(() => Array.isArray(props.node.children) && props.node.children.length > 0);
const detailTask = computed(() => {
  if (props.node.type === 'agent_call') return cleanText(props.node.description || '');
  return '';
});
const detailResult = computed(() => cleanText(props.node.result_summary || ''));
const hasDetails = computed(() => Boolean(
  props.node.type === 'tool_call'
  || detailTask.value
  || detailResult.value,
));
const expandable = computed(() => hasDetails.value || hasChildren.value);
const agentAccent = computed(() => (
  isAgentNode.value ? agentNodeAccentColor({
    ...props.node,
    participant_id: props.node.participant_id
      || props.node.linked_agent_call?.participant_id
      || props.node.agent_operation?.child_agent_id,
    agent_name: props.node.agent_name
      || props.node.linked_agent_call?.agent_name
      || props.node.agent_operation?.agent_name,
  }) : ''
));
// 缩进步长 = 步骤图标宽 + 行内 gap，取值与样式里的 .assistant-step-icon / .assistant-step-row 一致。
// 三个缩进公式都由它推出：行首、展开体（再让一个步长，与步骤文字对齐）、
// 思考竖线（落在图标中心，即步长起点 + 半个图标）。
const STEP_ICON_SIZE = 14;
const STEP_ROW_GAP = 8;
const STEP_INDENT = STEP_ICON_SIZE + STEP_ROW_GAP;

const indentStyle = computed(() => ({ paddingLeft: `${props.depth * STEP_INDENT}px` }));
const detailIndentStyle = computed(() => ({ marginLeft: `${props.depth * STEP_INDENT + STEP_INDENT}px` }));
const reasoningLineStyle = computed(() => ({ '--reasoning-line-left': `${props.depth * STEP_INDENT + STEP_ICON_SIZE / 2}px` }));

const iconKind = computed(() => {
  if (isAgentNode.value) return 'agent';
  if (props.node.type === 'tool_call') return getToolIconKind(props.node.tool_name);
  return 'step';
});
const iconLabel = computed(() => {
  if (isAgentNode.value) return 'Agent';
  return '工具';
});
const titleText = computed(() => {
  if (props.node.type === 'agent_call') {
    return props.node.agent_display_name || props.node.agent_name || 'Agent';
  }
  if (isAgentOperation.value) return getAgentOperationTitle(props.node);
  if (props.node.type === 'tool_call') return getToolDisplayName(props.node);
  return '执行步骤';
});
const summaryText = computed(() => {
  if (status.value === 'running') return '运行中';
  if (status.value === 'error') return '失败';
  if (status.value === 'stopped') return '已中断';
  if (props.node.type === 'tool_call') {
    if (isAgentOperation.value) {
      if (props.node.agent_operation?.delivery_status === 'queued') return '消息已入队';
      return truncate(cleanText(props.node.linked_agent_call?.result_summary || props.node.result_preview || props.node.result || ''), 42);
    }
    return truncate(getToolSubtitle(props.node) || cleanText(props.node.result_preview || props.node.result || ''), 42);
  }
  if (props.node.type === 'agent_call') return truncate(cleanText(props.node.result_summary || ''), 42);
  return '';
});

watch(() => getExecutionNodeKey(props.node), () => {
  expanded.value = false;
  reasoningOverride.value = null;
  reasoningUserPinned.value = false;
  lastReasoningScrollTop = 0;
  cancelPendingReasoningFrame();
  renderReasoningFrame();
});

// 思考块折叠:流式中自动展开,完成后自动收起;用户点击后本次覆盖自动行为。
const reasoningStreaming = computed(() => props.running && props.node.reasoning_complete === false);
const reasoningOverride = ref(null);
const reasoningExpanded = computed(() => (
  reasoningOverride.value !== null ? reasoningOverride.value : reasoningStreaming.value
));

function toggleReasoningExpanded() {
  reasoningOverride.value = !reasoningExpanded.value;
}

/* 思考正文：思维链是模型原始文本，按纯文本渲染（不走 markdown）。流式更新用
   appendData 尾部追加——整体替换文本节点会让浏览器对全文重新断行（O(n)/帧，
   长思考累计 O(n²) 掉帧）；尾部追加只让最后一行行盒失效，成本 O(增量)，
   流式期间全文在场、可自由回读。非追加式更新（历史回填/完成覆盖）全量替换兜底。
   这块 DOM 由本组件直接管理，不走 Vue 插值。 */
const reasoningEl = ref(null);
const reasoningTextEl = ref(null);
const reasoningUserPinned = ref(false);
let reasoningTextNode = null;
let reasoningRenderedText = '';
let reasoningRafId = 0;

function renderReasoningText(text) {
  const el = reasoningTextEl.value;
  if (!el) return;
  if (!reasoningTextNode || reasoningTextNode.parentNode !== el) {
    reasoningTextNode = document.createTextNode('');
    el.replaceChildren(reasoningTextNode);
    reasoningRenderedText = '';
  }
  if (text.startsWith(reasoningRenderedText)) {
    if (text.length > reasoningRenderedText.length) {
      reasoningTextNode.appendData(text.slice(reasoningRenderedText.length));
    }
  } else {
    reasoningTextNode.data = text;
  }
  reasoningRenderedText = text;
}

/* 渲染一帧并处理跟随：DOM 是本组件直接写的，随后读 scrollHeight 即是新布局，
   不需要等 nextTick。 */
function renderReasoningFrame() {
  renderReasoningText(props.node.reasoning || '');
  if (!reasoningUserPinned.value && reasoningExpanded.value) stickReasoningToBottom();
  updateReasoningFades();
}

function cancelPendingReasoningFrame() {
  if (!reasoningRafId) return;
  window.cancelAnimationFrame(reasoningRafId);
  reasoningRafId = 0;
}

watch(() => props.node.reasoning, () => {
  if (reasoningRafId) return;
  reasoningRafId = window.requestAnimationFrame(() => {
    reasoningRafId = 0;
    renderReasoningFrame();
  });
}, { immediate: true, flush: 'post' });

watch(reasoningStreaming, (streaming) => {
  if (streaming) return;
  // 完成覆盖可能是非追加式全文：取消在途帧，立即同步渲染。
  cancelPendingReasoningFrame();
  renderReasoningFrame();
});

/* 底部跟随：滚轮上滚（阅读意图）立即 pin，滚回底部（delta>0 且 gap≈0）自动恢复；
   拖滚动条/键盘上滚由 scroll 事件里 delta<0 且 gap>8 兜底 pin。
   不用"程序滚动后短窗内忽略 scroll 事件"的时间窗——流式期间程序滚动每帧发生，
   时间窗永不闭合，用户滚动会被持续吞掉。程序滚动恒落在 gap=0，天然不干扰 pin 态。 */
let lastReasoningScrollTop = 0;

function handleReasoningWheel(event) {
  if (event.deltaY >= 0) return;
  const el = reasoningEl.value;
  if (!el || el.scrollHeight <= el.clientHeight + 1) return;
  reasoningUserPinned.value = true;
}

function handleReasoningScroll() {
  const el = reasoningEl.value;
  if (!el) return;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  const delta = el.scrollTop - lastReasoningScrollTop;
  lastReasoningScrollTop = el.scrollTop;
  if (delta > 0 && gap <= 2) reasoningUserPinned.value = false;
  else if (delta < 0 && gap > 8) reasoningUserPinned.value = true;
  updateReasoningFades();
}

function stickReasoningToBottom() {
  const el = reasoningEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

// 上下渐变遮罩：只在对应方向还有未滚到的内容时出现，滚到头即消失。
const reasoningTopFaded = ref(false);
const reasoningBottomFaded = ref(false);

function updateReasoningFades() {
  const el = reasoningEl.value;
  if (!el) return;
  reasoningTopFaded.value = el.scrollTop > 4;
  reasoningBottomFaded.value = el.scrollHeight - el.scrollTop - el.clientHeight > 4;
}

watch(reasoningExpanded, (open) => {
  nextTick(() => {
    updateReasoningFades();
    // 流式中（手动收起后）重新展开：直接定位到最新内容，保持吸附。
    if (open && reasoningStreaming.value) stickReasoningToBottom();
  });
});

onBeforeUnmount(() => {
  cancelPendingReasoningFrame();
});

/* 高度动画：max-height 用实测值驱动（cap 320px——展开动画结束后上限释放回 320px，
   流式增长的内容仍有滚动空间）。细节见 useCollapsibleHeight。 */
const reasoningClipEl = ref(null);
useCollapsibleHeight(reasoningClipEl, reasoningExpanded, { cap: 320 });

/* 详情/子步骤折叠：与思考块同机制。结果流式就绪会让 hasDetails/hasChildren 中途变真，
   容器在展开态下晚挂载——useCollapsibleHeight 在元素出现时按当前展开态补一次同步。 */
const detailWrapEl = ref(null);
const childWrapEl = ref(null);
useCollapsibleHeight(detailWrapEl, expanded);
useCollapsibleHeight(childWrapEl, expanded);

function toggleExpanded() {
  if (expandable.value) expanded.value = !expanded.value;
}

function nodeKey(node, index) {
  return getExecutionNodeKey(node) || `${node.type || 'step'}-${index}`;
}

function cleanText(value) {
  if (!value) return '';
  let text = String(value);
  const toolResult = text.match(/<tool_result[^>]*>([\s\S]*?)<\/tool_result>/i);
  if (toolResult) text = toolResult[1];
  const cdata = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) text = cdata[1];
  return text
    .replace(/<\/?(?:result|observation|output)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
</script>

<style scoped>
.assistant-step-node {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

/* 轮文本容器：段尾输出与 intent 共用同一套容器几何——段尾输出在下一轮文字
   开始时降级为 intent，padding 不一致会让上方内容瞬间位移。 */
.assistant-step-tail-output,
.assistant-step-intent {
  min-width: 0;
  padding-block: 4px;
}

/* 轮文本排版：与最终答案消息行同款（chat-view.css 的 .message.assistant
   .markdown-body，14px/1.7）。段尾输出流式态 → 降级为 intent → run 终态由
   最终答案行接管，三处字号/行高必须一致，任何一处偏离都会让正在读的文字
   突然缩放；改动需与 chat-view.css 同步。 */
.assistant-step-tail-output :deep(.markdown-body),
.assistant-step-intent :deep(.markdown-body) {
  font-size: 14px;
  line-height: 1.7;
}

/* markdown 末元素的 margin-bottom 会被 BFC 容器包含，在块尾留出空白；统一清零。 */
.assistant-step-tail-output :deep(.markdown-body > :last-child),
.assistant-step-intent :deep(.markdown-body > :last-child) {
  margin-bottom: 0;
}

.assistant-step-brain {
  width: 14px;
  height: 14px;
}

/* 思考正文按纯文本渲染（pre-wrap），不走 markdown：思维链是模型原始文本，
   markdown 流式全量重解析是长思考掉帧的主因之一。 */
.assistant-step-reasoning-text {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.7;
  color: var(--color-text-secondary);
}

.assistant-step-row {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding-block: 3px;
  padding-right: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 14px;
  line-height: 1.7;
  text-align: left;
  cursor: pointer;
}

.assistant-step-icon {
  display: inline-flex;
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  align-items: center;
  justify-content: center;
  transition: color var(--transition-fast);
}

.assistant-step-icon :deep(svg) {
  width: 14px;
  height: 14px;
}

/* 不加 color 过渡：shimmer 切换要求 color: transparent 与渐变背景同帧增减——
   若 color 参与过渡，运行结束时渐变瞬间消失而文字从透明淡入，会闪一下。 */
/* 过程行统一用四级色：intent 行与工具行同色（参考实现里两者同为“正文四成”的一档灰），
   图标、名字、摘要一视同仁，行内不再分主次——分主次会让人误以为某段是重点。 */
.assistant-step-icon,
.assistant-step-name,
.assistant-step-summary {
  color: var(--color-text-tertiary);
}

.assistant-step-name {
  flex-shrink: 0;
  font-weight: 500;
}

.assistant-step-summary {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--transition-fast);
}

.assistant-step-chevron {
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  transition: transform var(--transition-fast);
}

.assistant-step-chevron.open {
  transform: rotate(180deg);
}

.assistant-step-row.status-running .assistant-step-icon {
  color: var(--color-brand-accent);
}

/* agent 节点:icon + 名称按该 agent 语义色着色,与侧栏/运行中心同色。
   运行中 accent 优先级更高(status-running 在后覆盖)。 */
.assistant-step-row.is-agent .assistant-step-icon,
.assistant-step-row.is-agent .assistant-step-name {
  color: var(--agent-accent, var(--color-text-muted));
}

.assistant-step-row.is-agent.status-running .assistant-step-icon {
  color: var(--agent-accent, var(--color-brand-accent));
}

.assistant-step-row.is-agent.status-error .assistant-step-icon,
.assistant-step-row.is-agent.status-error .assistant-step-name,
.assistant-step-row.is-agent.status-error .assistant-step-summary {
  color: var(--color-error);
}

.assistant-step-row.status-error .assistant-step-icon,
.assistant-step-row.status-error .assistant-step-name,
.assistant-step-row.status-error .assistant-step-summary {
  color: var(--color-error);
}

/* 运行态"光拂过"：图标保持原样（仅着色），步骤名以掠过的高对比光带呈现运行
   态——渐变裁切到文字上（background-clip: text），动画移动背景位置。基色用
   muted、光带用 text-primary，明暗两种主题下光带都是对比度更高的扫过区。
   无缝循环的数学约束：size 300% 且位移 150%→0%，总位移恰为一个瓦片周期
   （两端相位相同），且两端名字都落在光带（42%~58%）之外的静默区——改
   size/百分比必须重新满足这两条，否则循环接缝处会跳变。周期 3s：扫过
   ~1.5s + 静默 ~1.5s。选择器带 .assistant-step-row 前缀并置于各名称着色
   规则之后，确保 color: transparent 在 specificity/顺序上稳赢（否则实色
   字会盖住渐变）。 */
.assistant-step-row .assistant-step-name.is-shimmer {
  background: linear-gradient(
    100deg,
    var(--color-text-muted) 42%,
    var(--color-text-primary) 50%,
    var(--color-text-muted) 58%
  );
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: assistant-step-sweep 3s linear infinite;
}

@keyframes assistant-step-sweep {
  from { background-position: 150% 0; }
  to { background-position: 0% 0; }
}

/* 折叠容器（工具/agent 详情与子步骤）：max-height 由 useCollapsibleHeight 以实测高度内联
   驱动，展开动画结束后释放上限（none）。不用 grid 0fr/1fr——Chrome 在 fr 过渡期对
   grid item 的 stretch 解析有缺陷（容器按插值高度占位、内容不跟随），收起动画会在
   内容下方留出一段空白；max-height 直接驱动容器自身高度，任意中间态都贴合。
   展开稍长、收起略快。 */
.assistant-step-detail-wrap,
.assistant-step-child-wrap {
  max-height: 0;
  overflow: hidden;
  transition: max-height 180ms linear, margin-bottom 180ms linear;
}

.assistant-step-detail-wrap.is-open,
.assistant-step-child-wrap.is-open {
  transition: max-height 240ms linear, margin-bottom 240ms linear;
}

.assistant-step-detail-wrap.is-open {
  margin-bottom: 10px;
}

/* 裁剪层：max-height 折叠动画。不用 grid 0fr/1fr——Chrome 在 fr 过渡期对 grid item
   的 stretch 解析有缺陷（clip 不填满轨道、容器却按完整插值高度占位），动画过程中
   会在内容下方留出一段空白；max-height 直接驱动 clip 自身高度，任意中间态都贴合。
   与滚动层分离保证动画期间滚动条几何不变（揭开/盖上一张静止的内容快照）。 */
/* 展开/收起同速（240ms 匀速）；max-height 目标值由 useCollapsibleHeight 以实测高度内联驱动。 */
.assistant-step-reasoning-clip {
  max-height: 0;
  overflow: hidden;
  transition: max-height 240ms linear;
}

/* 滚动层：高度只取决于自身内容（≤320px），不随外层折叠动画变化。 */
.assistant-step-reasoning {
  max-height: 320px;
  overflow-x: hidden;
  overflow-y: auto;
}

/* 左侧竖线：1px，位于思考图标中心的正下方（随缩进层级），随展开高度生长。 */
.assistant-step-reasoning-wrap {
  position: relative;
}

.assistant-step-reasoning-wrap::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--reasoning-line-left, 7px);
  width: 1px;
  background: var(--color-bg-tertiary);
  pointer-events: none;
}

/* 上/下渐变遮罩：对应方向还有未滚到的内容时出现，滚到头消失；颜色用 rail 面色。 */
.assistant-step-reasoning-wrap::after,
.assistant-step-reasoning-fade {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 24px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;
}

.assistant-step-reasoning-wrap::after {
  top: 0;
  background: linear-gradient(to bottom, var(--surface-rail, transparent), transparent);
}

.assistant-step-reasoning-fade.is-bottom {
  bottom: 0;
  background: linear-gradient(to top, var(--surface-rail, transparent), transparent);
}

.assistant-step-reasoning-wrap.is-open.is-scrolled-top::after,
.assistant-step-reasoning-wrap.is-open.is-scrolled-bottom .assistant-step-reasoning-fade {
  opacity: 1;
}

.assistant-step-detail {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.assistant-step-detail-block {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.assistant-step-detail-label {
  color: var(--color-text-muted);
  font-size: 10.5px;
  font-weight: 600;
}

.assistant-step-detail-text {
  max-height: 200px;
  margin: 0;
  overflow: auto;
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  padding: 7px 9px;
  white-space: pre-wrap;
}

.assistant-step-detail-text.is-error {
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

@media (prefers-reduced-motion: reduce) {
  .assistant-step-row .assistant-step-name.is-shimmer {
    animation: none;
    background: none;
    color: inherit;
  }

  .assistant-step-detail-wrap,
  .assistant-step-child-wrap,
  .assistant-step-reasoning-clip,
  .assistant-step-detail,
  .assistant-step-reasoning,
  .assistant-step-chevron,
  .assistant-step-icon,
  .assistant-step-name,
  .assistant-step-summary {
    transition-duration: 1ms;
  }
}
</style>
