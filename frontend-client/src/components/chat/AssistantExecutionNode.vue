<template>
  <div class="assistant-step-node">
    <template v-if="node.type === 'thought'">
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
        :class="[`status-${status}`, { 'is-agent': node.type === 'agent_call' }]"
        :style="[indentStyle, node.type === 'agent_call' ? { '--agent-accent': agentAccent } : null]"
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

      <div v-if="hasDetails" class="assistant-step-detail-wrap" :class="{ 'is-open': expanded }">
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

      <div v-if="hasChildren" class="assistant-step-child-wrap" :class="{ 'is-open': expanded }">
        <div class="assistant-step-child-clip">
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
      </div>
    </template>
  </div>
</template>

<script setup>
import { ChevronDown } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
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
  props.node.type === 'agent_call' ? agentNodeAccentColor(props.node) : ''
));
const indentStyle = computed(() => ({ paddingLeft: `${props.depth * 22}px` }));
const detailIndentStyle = computed(() => ({ marginLeft: `${props.depth * 22 + 22}px` }));

const iconKind = computed(() => {
  if (props.node.type === 'agent_call') return 'agent';
  if (props.node.type === 'agent_message' || props.node.type === 'injection') return 'input';
  if (props.node.type === 'tool_call') return getToolIconKind(props.node.tool_name);
  return 'step';
});
const iconLabel = computed(() => {
  if (props.node.type === 'agent_call') return 'Agent';
  if (props.node.type === 'agent_message') return 'Agent 消息';
  if (props.node.type === 'injection') return '用户补充';
  return '工具';
});
const titleText = computed(() => {
  if (props.node.type === 'agent_call') {
    return props.node.agent_display_name || props.node.agent_name || 'Agent';
  }
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
    return truncate(getToolSubtitle(props.node) || cleanText(props.node.result_preview || props.node.result || ''), 42);
  }
  if (props.node.type === 'agent_call') return truncate(cleanText(props.node.result_summary || ''), 42);
  return '';
});

watch(() => getExecutionNodeKey(props.node), () => {
  expanded.value = false;
});

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

.assistant-step-detail-wrap,
.assistant-step-child-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 240ms var(--ease-out-expo, ease), margin-bottom 240ms var(--ease-out-expo, ease);
}

.assistant-step-detail-wrap.is-open,
.assistant-step-child-wrap.is-open {
  grid-template-rows: 1fr;
}

.assistant-step-detail-wrap.is-open {
  margin-bottom: 10px;
}

.assistant-step-detail,
.assistant-step-child-clip {
  min-height: 0;
  overflow: hidden;
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
  .assistant-step-chevron,
  .assistant-step-icon,
  .assistant-step-name,
  .assistant-step-summary {
    transition-duration: 1ms;
  }
}
</style>
