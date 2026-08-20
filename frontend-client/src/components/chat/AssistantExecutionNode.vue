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
          <svg v-if="reasoningStreaming" class="assistant-step-spinner" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="34 14" />
          </svg>
          <Brain v-else aria-hidden="true" />
        </span>
        <span class="assistant-step-name">深度思考</span>
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
            @scroll.passive="updateReasoningFades"
          >
            <MarkdownContent
              :content="node.reasoning || ''"
              :streaming="reasoningStreaming"
              @notify="emit('notify', $event)"
              @citation-click="emit('citation-click', $event)"
            />
          </div>
        </div>
        <div class="assistant-step-reasoning-fade is-bottom" aria-hidden="true"></div>
      </div>
    </template>

    <template v-else-if="node.type === 'thought'">
      <div class="assistant-step-intent" :style="indentStyle">
        <MarkdownContent
          :content="node.intent || ''"
          :streaming="running && node.intent_complete === false"
          @notify="emit('notify', $event)"
          @citation-click="emit('citation-click', $event)"
        />
      </div>
      <div v-if="hasChildren" class="assistant-step-children">
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
          <svg v-if="status === 'running'" class="assistant-step-spinner" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="34 14" />
          </svg>
          <WorkPanelTimelineIcon v-else :kind="iconKind" />
        </span>
        <span class="assistant-step-name">{{ titleText }}</span>
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
          <template v-if="node.type === 'tool_call'">
            <div class="assistant-step-detail-block">
              <span class="assistant-step-detail-label">参数</span>
              <pre class="assistant-step-detail-pre">{{ formatArguments(node.arguments) }}</pre>
            </div>
            <div class="assistant-step-detail-block">
              <span class="assistant-step-detail-label">结果</span>
              <div class="assistant-step-detail-text" :class="{ 'is-error': status === 'error' }">
                {{ detailResult }}
              </div>
            </div>
          </template>

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
import MarkdownContent from './MarkdownContent.vue';

defineOptions({ name: 'AssistantExecutionNode' });

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  running: { type: Boolean, default: false },
});

const emit = defineEmits(['notify', 'citation-click']);
const expanded = ref(false);
const status = computed(() => normalizeExecutionStatus(props.node.status));
const isAgentOperation = computed(() => props.node.type === 'tool_call' && props.node.tool_name === 'agent');
const isAgentNode = computed(() => props.node.type === 'agent_call' || isAgentOperation.value);
const hasChildren = computed(() => Array.isArray(props.node.children) && props.node.children.length > 0);
const detailTask = computed(() => {
  if (props.node.type === 'agent_call') return cleanText(props.node.description || '');
  if (props.node.type === 'injection' || props.node.type === 'agent_message') return cleanText(props.node.content || '');
  return '';
});
const detailResult = computed(() => {
  if (props.node.type === 'tool_call') {
    if (status.value === 'running') return '执行中...';
    return cleanText(props.node.result || props.node.result_preview || '')
      || (status.value === 'error' ? '失败（无结果）' : '（无结果）');
  }
  return cleanText(props.node.result_summary || '');
});
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
const indentStyle = computed(() => ({ paddingLeft: `${props.depth * 22}px` }));
const detailIndentStyle = computed(() => ({ marginLeft: `${props.depth * 22 + 22}px` }));
// 竖线挂在思考图标（14px）中心的正下方，随节点缩进层级对齐。
const reasoningLineStyle = computed(() => ({ '--reasoning-line-left': `${props.depth * 22 + 7}px` }));

const iconKind = computed(() => {
  if (isAgentNode.value) return 'agent';
  if (props.node.type === 'agent_message' || props.node.type === 'injection') return 'input';
  if (props.node.type === 'tool_call') return getToolIconKind(props.node.tool_name);
  return 'step';
});
const iconLabel = computed(() => {
  if (isAgentNode.value) return 'Agent';
  if (props.node.type === 'agent_message') return 'Agent 消息';
  if (props.node.type === 'injection') return '用户补充';
  return '工具';
});
const titleText = computed(() => {
  if (props.node.type === 'agent_call') {
    return props.node.agent_display_name || props.node.agent_name || 'Agent';
  }
  if (isAgentOperation.value) return getAgentOperationTitle(props.node);
  if (props.node.type === 'agent_message') return props.node.message_kind || 'Agent 消息';
  if (props.node.type === 'injection') return '用户补充';
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

// 流式时思考块自动跟随最新内容；用户主动上滑阅读（距底 >40px）则不打扰。
// 吸附判定在渲染前读旧位置；滚动必须等渲染后读新 scrollHeight——提前读永远差一截，
// 且单次增量渲染超过 40px 时会被误判成用户上滑而永久停止跟随。
const reasoningEl = ref(null);
watch(() => props.node.reasoning, () => {
  const el = reasoningEl.value;
  const stickToBottom = Boolean(el) && el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
  nextTick(() => {
    if (el && stickToBottom && reasoningStreaming.value && reasoningExpanded.value) {
      el.scrollTop = el.scrollHeight;
    }
    updateReasoningFades();
    retargetReasoningHeight();
  });
});

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
    syncReasoningHeight(open);
    // 流式中（手动收起后）重新展开：直接定位到最新内容，保持吸附。
    const el = reasoningEl.value;
    if (open && reasoningStreaming.value && el) el.scrollTop = el.scrollHeight;
  });
});

onBeforeUnmount(() => {
  window.clearTimeout(reasoningHeightTimer);
  window.clearTimeout(collapseHeightTimer);
});

/* 高度动画：max-height 用实测值驱动。固定 320px 区间会让短内容在过渡早期
   就到达实际高度、其后全是不可见的空跑，观感上"过快"；展开动画结束后
   把上限放回 320px，流式增长的内容仍有滚动空间。 */
const reasoningClipEl = ref(null);
let reasoningHeightTimer = 0;

function syncReasoningHeight(open) {
  const clip = reasoningClipEl.value;
  if (!clip) return;
  window.clearTimeout(reasoningHeightTimer);
  if (open) {
    const target = Math.min(clip.scrollHeight, 320);
    clip.style.maxHeight = `${target}px`;
    scheduleReasoningRelease(clip);
  } else {
    // 钉住到当前可视高度时需临时禁用过渡：上限(320)→实测值的跳变本身不可见，
    // 若作为过渡处理会让 max-height 从 320 插值到 0，短内容在越过自身高度前
    // 一直无视觉变化，最后才瞬间收完。
    clip.style.transition = 'none';
    clip.style.maxHeight = `${clip.offsetHeight}px`;
    void clip.offsetHeight;
    clip.style.transition = '';
    clip.style.maxHeight = '0px';
  }
}

function scheduleReasoningRelease(clip) {
  reasoningHeightTimer = window.setTimeout(() => {
    if (reasoningExpanded.value) clip.style.maxHeight = '320px';
  }, 260);
}

/* 流式内容增长：上限仍钉在旧的实测值时平滑过渡到新高度（只增不减）。
   不重排释放定时器——流式增量若每次续期，上限会一直处在追赶过渡中，最新内容
   长期被裁在可视区外；初次展开排定的释放照常触发后，交还给 320px 上限+滚动层。 */
function retargetReasoningHeight() {
  if (!reasoningExpanded.value) return;
  const clip = reasoningClipEl.value;
  if (!clip) return;
  const cap = clip.style.maxHeight;
  if (!cap || cap === 'none' || cap === '320px') return;
  const target = Math.min(clip.scrollHeight, 320);
  if (target <= parseFloat(cap)) return;
  clip.style.maxHeight = `${target}px`;
}

/* 详情/子步骤折叠：与思考块、外层步骤面板同思路，max-height 用实测值驱动（不用
   grid 0fr/1fr——Chrome 在 fr 过渡期对 grid item 的 stretch 解析有缺陷，收起动画
   会在内容下方留出空白）；展开动画结束后释放上限，流式新增的子节点/结果不被裁剪。 */
const detailWrapEl = ref(null);
const childWrapEl = ref(null);
let collapseHeightTimer = 0;

watch(expanded, (open) => {
  nextTick(() => syncCollapseHeight(open));
});

/* 结果流式就绪会让 hasDetails/hasChildren 中途变真：容器在展开态下才挂载，max-height
   仍是 CSS 初值 0，需补一次高度同步。 */
watch([hasDetails, hasChildren], ([details, children], [prevDetails, prevChildren]) => {
  if (expanded.value && ((details && !prevDetails) || (children && !prevChildren))) {
    nextTick(() => syncCollapseHeight(true));
  }
});

function syncCollapseHeight(open) {
  window.clearTimeout(collapseHeightTimer);
  const wraps = collapseWraps();
  if (open) {
    for (const el of wraps) el.style.maxHeight = `${el.scrollHeight}px`;
    if (wraps.length) scheduleCollapseRelease();
    return;
  }
  for (const el of wraps) {
    if (el.style.maxHeight === 'none') {
      el.style.maxHeight = `${el.scrollHeight}px`;
      void el.offsetHeight;
    }
    el.style.maxHeight = '0px';
  }
}

function scheduleCollapseRelease() {
  collapseHeightTimer = window.setTimeout(() => {
    if (!expanded.value) return;
    for (const el of collapseWraps()) el.style.maxHeight = 'none';
  }, 260);
}

/* 展开期间内容变化（流式新增子节点/结果）：上限仍钉在旧实测值时平滑过渡到新高度。
   不重排释放定时器——连续流式会不断续期，容器高度一直在过渡中追赶内容，底部最新
   内容长期被裁；初次展开排定的释放照常触发后，上限交还给内容自身。 */
watch(() => props.node, () => {
  if (!expanded.value) return;
  const pinned = collapseWraps().filter(el => el.style.maxHeight && el.style.maxHeight !== 'none');
  if (!pinned.length) return;
  for (const el of pinned) el.style.maxHeight = `${el.scrollHeight}px`;
});

function collapseWraps() {
  return [detailWrapEl.value, childWrapEl.value].filter(Boolean);
}

function toggleExpanded() {
  if (expandable.value) expanded.value = !expanded.value;
}

function nodeKey(node, index) {
  return getExecutionNodeKey(node) || `${node.type || 'step'}-${index}`;
}

function formatArguments(value) {
  if (value === undefined || value === null) return '（无）';
  if (typeof value === 'string') return value.trim() || '（无）';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

.assistant-step-intent {
  min-width: 0;
  padding-block: 4px;
}

.assistant-step-intent :deep(.markdown-body) {
  font-size: 14px;
  line-height: 1.7;
}

.assistant-step-brain {
  width: 14px;
  height: 14px;
}

.assistant-step-reasoning :deep(.markdown-body) {
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
  font-size: 11.5px;
  line-height: 1.5;
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
  color: var(--color-text-muted);
  transition: color var(--transition-fast);
}

.assistant-step-icon :deep(svg) {
  width: 14px;
  height: 14px;
}

.assistant-step-spinner {
  display: block;
  animation: assistant-step-spin 0.9s linear infinite;
}

.assistant-step-name {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-weight: 500;
  transition: color var(--transition-fast);
}

.assistant-step-summary {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text-tertiary, var(--color-text-muted));
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--transition-fast);
}

.assistant-step-chevron {
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
  color: var(--color-text-muted);
  transition: transform var(--transition-fast);
}

.assistant-step-chevron.open {
  transform: rotate(180deg);
}

.assistant-step-row.status-running .assistant-step-icon,
.assistant-step-row.status-running .assistant-step-name {
  color: var(--color-brand-accent);
}

/* agent 节点:icon + 名称按该 agent 语义色着色,与侧栏/运行中心同色。
   运行中 accent 优先级更高(status-running 在后覆盖)。 */
.assistant-step-row.is-agent .assistant-step-icon,
.assistant-step-row.is-agent .assistant-step-name {
  color: var(--agent-accent, var(--color-text-muted));
}

.assistant-step-row.is-agent.status-running .assistant-step-icon,
.assistant-step-row.is-agent.status-running .assistant-step-name {
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

/* 折叠容器（工具/agent 详情与子步骤）：max-height 由 syncCollapseHeight 以实测高度内联
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
/* 展开/收起同速（240ms 匀速）；max-height 目标值由 syncReasoningHeight 以实测高度内联驱动。 */
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

/* markdown 末元素的 margin-bottom 会被 BFC 容器包含，在块尾留出空白；思考块与 intent 块统一清零。 */
.assistant-step-reasoning :deep(.markdown-body > :last-child),
.assistant-step-intent :deep(.markdown-body > :last-child) {
  margin-bottom: 0;
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

.assistant-step-detail-pre,
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

.assistant-step-detail-pre {
  max-height: 160px;
  font-family: var(--font-mono);
}

.assistant-step-detail-text.is-error {
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

@keyframes assistant-step-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .assistant-step-spinner {
    animation: none;
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
