<template>
  <div class="execution-node" :class="node.type">
    <!-- 意图节点 -->
    <div v-if="node.type === 'thought'" class="node-thought" :class="{ running: isRunning }">
      <div class="thought-header" v-if="node.round || node.agent_display_name || node.agent">
        <span class="agent-badge" :class="getAgentBadgeClass(node.agent)">
          <transition name="status-dot-fade">
            <span v-if="isRunning" class="badge-status-dot running"></span>
          </transition>
          {{ node.agent_display_name || node.agent }}
        </span>
        <span v-if="showRoundBadge" class="round-badge">轮次 {{ node.round }}</span>
      </div>
      <div class="thought-content" v-if="node.intent || node.thought">{{ node.intent || node.thought }}</div>
      <div class="thought-thinking" v-else-if="isRunning">
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-label">思考中</span>
      </div>
    </div>

    <!-- 智能体调用节点 -->
    <div v-else-if="node.type === 'agent_call'" class="node-agent-call" :class="[node.status, { expanded: localExpanded }]">
      <div class="agent-call-header" @click="toggleExpanded">
        <span class="expand-icon" :class="{ expanded: localExpanded }">
          <svg class="expand-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
            <polyline
              points="8 5 16 12 8 19"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="agent-badge" :class="getAgentBadgeClass(node.agent_name)">
          {{ node.agent_display_name || node.agent_name }}
        </span>
        <span v-if="node.order" class="order-badge">
          步骤 {{ getStepLabel(node) }}
        </span>
        <div v-if="toolCallStatuses.length > 0" class="substep-dots">
          <span v-for="(s, i) in toolCallStatuses.slice(0, 8)" :key="i"
                class="substep-dot" :class="s"></span>
          <span v-if="toolCallStatuses.length > 8" class="substep-dots-more">+{{ toolCallStatuses.length - 8 }}</span>
        </div>
        <span class="status-badge" :class="node.status">
          {{ getStatusText(node.status) }}
        </span>
        <!-- 上下文用量圆形进度 -->
        <span v-if="node.ctx && node.ctx.max > 0" class="ctx-ring" :title="`上下文: ${node.ctx.used.toLocaleString()} / ${node.ctx.max.toLocaleString()} tokens`">
          <svg width="20" height="20" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="8" fill="none" stroke="var(--ctx-ring-track)" stroke-width="2.5" />
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              :stroke="ctxColor"
              stroke-width="2.5"
              stroke-linecap="round"
              :stroke-dasharray="`${ctxPct * 0.5027} 50.27`"
              stroke-dashoffset="0"
              :style="{ transform: 'rotate(90deg) scaleX(-1)', transformOrigin: '50% 50%' }"
            />
          </svg>
        </span>
      </div>

      <!-- 详情区（grid 折叠动画，展开时可见） -->
      <div class="agent-call-detail-wrap" :class="{ expanded: localExpanded }">
        <div class="agent-call-details">
          <div class="description-full">
            <strong>任务描述：</strong>{{ node.description }}
          </div>

          <!-- 递归渲染子节点 -->
          <div v-if="node.children && node.children.length > 0" class="children-container">
            <ExecutionNode
              v-for="(child, index) in node.children"
              :key="index"
              :node="child"
              :level="level + 1"
              :session-id="sessionId"
            />
          </div>

          <!-- 结果摘要 -->
          <div v-if="node.result_summary" class="result-summary">
            <div class="section-header">执行结果</div>
            <div class="result-content">{{ node.result_summary }}</div>
          </div>
        </div>
      </div>

      <!-- 预览区（折叠时可见，展开时收起） -->
      <div class="agent-call-preview-wrap">
        <div class="agent-call-preview">
          <div
            class="clamp-box"
            :class="{ expanded: previewDescExpanded, interactive: descOverflows }"
            @click.stop="togglePreviewExpand('desc')"
          >
            <div class="description" ref="descRef" :style="descClampStyle">{{ node.description }}</div>
            <div v-if="descOverflows && !previewDescExpanded" class="clamp-fade"></div>
          </div>
          <div class="preview-meta" v-if="node.result_summary">
            <div
              class="clamp-box"
              :class="{ expanded: previewResultExpanded, interactive: resultOverflows }"
              @click.stop="togglePreviewExpand('result')"
            >
              <div class="result-preview" ref="resultRef" :style="resultClampStyle">{{ node.result_summary }}</div>
              <div v-if="resultOverflows && !previewResultExpanded" class="clamp-fade"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 外部悬浮收起按钮 -->
    <div v-if="node.type === 'agent_call' && localExpanded" class="collapse-trigger-external">
      <div class="trigger-content" @click="toggleExpanded">
        <svg class="icon-up" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg">
          <path d="M533.333333 512L341.333333 704l29.866667 29.866667 162.133333-162.133334 162.133334 162.133334 29.866666-29.866667-192-192z m0-256L341.333333 448l29.866667 29.866667 162.133333-162.133334 162.133334 162.133334 29.866666-29.866667L533.333333 256z" fill="currentColor"
          stroke="currentColor"
          stroke-width="30"></path>
        </svg>
      </div>
    </div>

    <!-- 外部展开按钮（预览模式下显示） -->
    <div v-else-if="node.type === 'agent_call' && !localExpanded" class="expand-trigger-external">
      <div class="trigger-content" @click="toggleExpanded">
        <svg class="icon-down" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg">
          <path d="M533.333333 512L341.333333 704l29.866667 29.866667 162.133333-162.133334 162.133334 162.133334 29.866666-29.866667-192-192z m0-256L341.333333 448l29.866667 29.866667 162.133333-162.133334 162.133334 162.133334 29.866666-29.866667L533.333333 256z" fill="currentColor"
          stroke="currentColor"
          stroke-width="30"></path>
        </svg>
      </div>
    </div>

    <!-- 工具调用节点 -->
    <div v-else-if="node.type === 'tool_call'" class="node-tool-call" :class="[node.status, { expanded: localExpanded }, { 'user-input-tool': node.tool_name === 'request_user_input' }]">
      <div class="tool-header" @click="toggleExpanded">
        <div class="tool-status-indicator">
          <div class="status-dot"></div>
          <div class="status-ring"></div>
        </div>
        <span class="tool-name">{{ toolDisplayName }}</span>
        <span v-if="!localExpanded && smartPreview" class="tool-smart-preview">{{ smartPreview }}</span>
        <div class="tool-meta">
          <span v-if="node.elapsed_time" class="tool-time">
            {{ node.elapsed_time.toFixed(2) }}s
          </span>
          <span class="tool-expand-btn" :class="{ rotated: localExpanded }">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </span>
        </div>
      </div>

      <div class="tool-details-wrap" :class="{ expanded: localExpanded }">
        <div class="tool-details">
          <!-- request_user_input：专属问答展示 -->
          <template v-if="node.tool_name === 'request_user_input'">
            <div v-if="node.arguments && node.arguments.prompt" class="detail-block user-input-prompt-block">
              <div class="detail-header">
                <span>智能体提问</span>
              </div>
              <div class="user-input-prompt">{{ node.arguments.prompt }}</div>
              <div v-if="node.arguments.options && node.arguments.options.length > 0" class="user-input-options">
                <span v-for="opt in node.arguments.options" :key="opt" class="option-chip">{{ opt }}</span>
              </div>
            </div>
            <div v-if="previewResult && previewResult !== '（已取消）'" class="detail-block user-input-answer-block">
              <div class="detail-header">
                <span>用户回答</span>
                <span class="code-tag user-tag">USER</span>
              </div>
              <div class="user-input-answer">{{ previewResult }}</div>
            </div>
            <div v-else-if="node.status === 'running'" class="detail-block">
              <div class="user-input-waiting">等待用户输入中…</div>
            </div>
          </template>

          <!-- 普通工具：通用 JSON 展示 -->
          <template v-else>
            <div v-if="Object.keys(node.arguments || {}).length > 0" class="detail-block">
              <div class="detail-header">
                <span>输入参数</span>
                <span class="code-tag">JSON</span>
              </div>
              <div class="code-wrapper">
                <pre class="detail-code">{{ JSON.stringify(node.arguments, null, 2) }}</pre>
              </div>
            </div>

            <!-- 结果展示 -->
            <div v-if="previewResult" class="detail-block">
              <div class="detail-header">
                <span>{{ resultViewMode === 'raw' ? 'Tool Raw Result' : 'Agent Observation' }}</span>
                <div class="detail-header-actions">
                  <button
                    v-if="canLoadRawResult || hasLoadedRawResult"
                    class="result-view-switch"
                    :class="`is-${resultViewMode}`"
                    :disabled="rawResultLoading"
                    @click.stop="handleResultAction"
                    :title="resultViewMode === 'raw' ? '切换到 Agent Observation' : '切换到 Tool Raw Result'"
                  >
                    <span class="result-view-switch-track">
                      <span class="result-view-switch-thumb"></span>
                      <span class="result-view-switch-label is-left">OBS</span>
                      <span class="result-view-switch-label is-right">RAW</span>
                    </span>
                  </button>
                </div>
              </div>
              <div class="code-wrapper">
                <pre class="detail-code result-code">{{ displayedResult }}</pre>
              </div>
              <div v-if="rawResultError" class="tool-result-error">{{ rawResultError }}</div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 递归渲染子节点（仅用于 thought 节点） -->
    <div v-if="node.type === 'thought' && node.children && node.children.length > 0" class="children-container">
      <ExecutionNode
        v-for="(child, index) in node.children"
        :key="index"
        :node="child"
        :level="level + 1"
        :session-id="sessionId"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, defineProps, nextTick, onMounted, watch } from 'vue';
import { getToolCallRawResult } from '../api/monitoring';
import { getAgentBadgeClass } from '../utils/agentBadge';

const props = defineProps({
  node: {
    type: Object,
    required: true
  },
  level: {
    type: Number,
    default: 0
  },
  sessionId: {
    type: String,
    default: ''
  }
});

// request_user_input 节点默认展开（让用户立即看到提问内容）
const defaultExpanded = props.node.expanded !== undefined
  ? props.node.expanded
  : props.node.tool_name === 'request_user_input';
const localExpanded = ref(defaultExpanded);
const previewDescExpanded = ref(false);
const previewResultExpanded = ref(false);
const descRef = ref(null);
const resultRef = ref(null);
const descOverflows = ref(false);
const resultOverflows = ref(false);
const descCollapsedHeight = ref(0);
const descExpandedHeight = ref(0);
const resultCollapsedHeight = ref(0);
const resultExpandedHeight = ref(0);

function measureClampHeights(el, collapsedLines = 3) {
  if (!el) return { collapsed: 0, expanded: 0, overflows: false };
  const styles = window.getComputedStyle(el);
  const lineHeight = parseFloat(styles.lineHeight) || 0;
  const expanded = el.scrollHeight;
  const collapsed = lineHeight > 0
    ? Math.ceil(lineHeight * collapsedLines)
    : expanded;
  return {
    collapsed,
    expanded,
    overflows: expanded > collapsed + 2,
  };
}

function checkOverflow() {
  if (descRef.value) {
    const { collapsed, expanded, overflows } = measureClampHeights(descRef.value);
    descCollapsedHeight.value = collapsed;
    descExpandedHeight.value = expanded;
    descOverflows.value = overflows;
    if (!overflows) previewDescExpanded.value = false;
  }
  if (resultRef.value) {
    const { collapsed, expanded, overflows } = measureClampHeights(resultRef.value);
    resultCollapsedHeight.value = collapsed;
    resultExpandedHeight.value = expanded;
    resultOverflows.value = overflows;
    if (!overflows) previewResultExpanded.value = false;
  }
}

const descClampStyle = computed(() => {
  if (!descOverflows.value) return {};
  return {
    maxHeight: `${previewDescExpanded.value ? descExpandedHeight.value : descCollapsedHeight.value}px`
  };
});

const resultClampStyle = computed(() => {
  if (!resultOverflows.value) return {};
  return {
    maxHeight: `${previewResultExpanded.value ? resultExpandedHeight.value : resultCollapsedHeight.value}px`
  };
});

onMounted(() => nextTick(checkOverflow));
watch(() => props.node.description, () => nextTick(checkOverflow));
watch(() => props.node.result_summary, () => nextTick(checkOverflow));
const rawResult = ref(null);
const rawResultLoading = ref(false);
const rawResultError = ref('');
const resultViewMode = ref('preview');

// 工具名展示映射
const TOOL_DISPLAY_NAMES = {
  'request_user_input': '请求用户输入',
};

// Skill 工具动态名称：从 arguments 中提取 skill_name
const SKILL_TOOL_TEMPLATES = {
  'activate_skill': (args) => `激活 ${args?.skill_name || 'Skill'}`,
  'load_skill_resource': (args) => `加载 ${args?.skill_name || 'Skill'} 资源`,
  'execute_skill_script': (args) => `执行 ${args?.skill_name || 'Skill'} 脚本`,
  'get_skill_info': (args) => `查询 ${args?.skill_name || 'Skill'} 信息`,
};

const toolDisplayName = computed(() => {
  const name = props.node.tool_name || '';
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name];
  const tpl = SKILL_TOOL_TEMPLATES[name];
  if (tpl) return tpl(props.node.arguments);
  return name;
});

const isRunning = computed(() => {
  if (props.node.type === 'thought') {
    if (props.node.status === 'running') return true;
    if (props.node.children) {
      return props.node.children.some(child => child.status === 'running');
    }
  }
  return false;
});

const isOrchestratorThought = computed(() => {
  return props.node?.type === 'thought' && props.level === 0;
});

const showRoundBadge = computed(() => {
  return Boolean(props.node?.round);
});

// 收集所有 tool_call 的状态序列（保持执行顺序）
const toolCallStatuses = computed(() => {
  if (props.node.type !== 'agent_call') return [];
  const statuses = [];
  const walk = (children) => {
    if (!children) return;
    for (const child of children) {
      if (child.type === 'tool_call') statuses.push(child.status || 'pending');
      if (child.children) walk(child.children);
    }
  };
  walk(props.node.children);
  return statuses;
});

// 工具结果智能预览
const smartPreview = computed(() => {
  if (props.node.type !== 'tool_call') return '';
  if (props.node.status === 'running') return '';
  const name = props.node.tool_name || '';
  // call_agent：显示目标 agent 名
  if (name === 'call_agent') {
    const agentName = props.node.linkedAgentCall?.agent_display_name
      || props.node.arguments?.agent_name || '';
    return agentName ? `→ ${agentName}` : '';
  }
  const preview = props.node.result_preview || props.node.result || '';

  let parsed = null;
  if (typeof preview === 'string') {
    try { parsed = JSON.parse(preview.trim()); } catch(_) {}
  } else if (typeof preview === 'object') {
    parsed = preview;
  }

  // 可视化工具
  if (['create_chart','create_map','create_bindmap','create_risk_map','revise_visualization'].includes(name)) {
    const title = parsed?.title || parsed?.preview?.title || '';
    return title ? `→ ${title}` : '→ 已生成';
  }
  // 查询工具
  if (name === 'query_emergency_plan') {
    const count = parsed?.results?.length ?? parsed?.total;
    if (count != null) return `→ ${count} 条结果`;
  }
  // 风险评估
  if (name === 'assess_flood_risk') {
    const level = parsed?.risk_level ?? parsed?.risk_label;
    if (level) return `→ ${level}级风险`;
  }
  // 报告
  if (name === 'generate_report') {
    const title = parsed?.title;
    if (title) return `→ ${title}`;
  }
  // 代码执行
  if (name === 'execute_code' || name === 'execute_bash') {
    const code = parsed?.exit_code ?? parsed?.metadata?.exit_code;
    if (code != null) return code === 0 ? '→ 成功' : `→ 退出码 ${code}`;
  }
  // 匹配方案
  if (name === 'match_emergency_response') {
    const count = parsed?.matched_plans?.length;
    if (count != null) return `→ ${count} 个匹配方案`;
  }
  // 默认：截取 summary 前 30 字符
  const summary = parsed?.summary || parsed?.message;
  if (summary && typeof summary === 'string') {
    return `→ ${summary.slice(0, 30)}${summary.length > 30 ? '…' : ''}`;
  }
  return '';
});

const ctxPct = computed(() => {
  const ctx = props.node.ctx;
  if (!ctx || !ctx.max) return 0;
  return Math.min(100, Math.round(ctx.used / ctx.max * 100));
});

const ctxColor = computed(() => {
  const p = ctxPct.value;
  if (p >= 90) return '#ff4d4f';
  if (p >= 70) return '#faad14';
  return '#52c41a';
});

const getStepLabel = (node) => {
  if (node.round !== undefined && node.round_index !== undefined) {
    return `${node.round}-${node.round_index}`;
  }
  return node.order;
};

const getStatusText = (status) => {
  const statusMap = {
    'running': '执行中',
    'success': '完成',
    'error': '失败'
  };
  return statusMap[status] || status;
};

// agent_call 折叠/展开，纯 CSS grid-template-rows 动画，无需 JS 测量高度
const toggleExpanded = () => {
  localExpanded.value = !localExpanded.value;
};

const togglePreviewExpand = (type) => {
  if (type === 'desc') {
    if (!descOverflows.value) return;
    previewDescExpanded.value = !previewDescExpanded.value;
    return;
  }
  if (!resultOverflows.value) return;
  previewResultExpanded.value = !previewResultExpanded.value;
};

const canLoadRawResult = computed(() => {
  return Boolean(
    props.sessionId &&
    props.node?.call_id &&
    (props.node?.raw_result_available || props.node?.raw_result_ref)
  );
});

const previewResult = computed(() => props.node?.result_preview ?? props.node?.result ?? '');

const inlineRawResult = computed(() => {
  if (!props.node || !Object.prototype.hasOwnProperty.call(props.node, 'raw_result')) {
    return null;
  }
  return props.node.raw_result;
});

const effectiveRawResult = computed(() => (
  rawResult.value !== null ? rawResult.value : inlineRawResult.value
));

const hasLoadedRawResult = computed(() => effectiveRawResult.value !== null);

const displayedResult = computed(() => {
  const value = resultViewMode.value === 'raw' && effectiveRawResult.value != null
    ? effectiveRawResult.value
    : previewResult.value;
  return formatResultContent(value);
});

const toggleResultView = () => {
  if (!hasLoadedRawResult.value) return;
  resultViewMode.value = resultViewMode.value === 'raw' ? 'preview' : 'raw';
};

const handleResultAction = () => {
  if (rawResultLoading.value) return;
  if (!hasLoadedRawResult.value) {
    loadRawResult();
    return;
  }
  toggleResultView();
};

const loadRawResult = async () => {
  if (!canLoadRawResult.value || rawResultLoading.value) return;
  rawResultLoading.value = true;
  rawResultError.value = '';
  try {
    const data = await getToolCallRawResult(props.sessionId, props.node.call_id);
    rawResult.value = data?.raw_result ?? null;
    if (rawResult.value == null) {
      rawResultError.value = '没有可用的原始结果';
      resultViewMode.value = 'preview';
    } else {
      resultViewMode.value = 'raw';
    }
  } catch (error) {
    rawResultError.value = error?.message || '原始结果加载失败';
  } finally {
    rawResultLoading.value = false;
  }
};

const formatResultContent = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== 'string') {
          return JSON.stringify(parsed, null, 2);
        }
      } catch (_) {
        // 历史数据可能就是普通文本，保持原样显示。
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
};
</script>

<style scoped>
.execution-node {
  animation: fadeInUp 0.3s ease-out;
}

.detail-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  margin-left: auto;
  flex-shrink: 0;
}

.result-view-switch {
  border: 0;
  background: transparent;
  padding: 0;
  margin: 0;
  cursor: pointer;
}

.result-view-switch:disabled {
  opacity: 0.65;
  cursor: wait;
}

.result-view-switch-track {
  position: relative;
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  align-items: center;
  width: 84px;
  height: 28px;
  padding: 2px;
  border-radius: var(--radius-full, 999px);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  transition:
    border-color 0.22s ease,
    background-color 0.22s ease,
    transform 0.22s ease;
}

.result-view-switch:hover .result-view-switch-track {
  border-color: var(--color-border-hover);
  background: var(--color-bg-secondary);
}

.result-view-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc(50% - 2px);
  height: calc(100% - 4px);
  border-radius: var(--radius-full, 999px);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  transition:
    transform 0.24s cubic-bezier(0.2, 0.9, 0.2, 1),
    background-color 0.22s ease,
    border-color 0.22s ease;
}

.result-view-switch-label {
  position: relative;
  z-index: 1;
  text-align: center;
  font-size: 0.68rem;
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0.01em;
  transition: all 0.22s ease;
  user-select: none;
  white-space: nowrap;
}

.result-view-switch.is-preview .result-view-switch-label.is-left {
  color: var(--color-text-primary);
  transform: scale(1.01);
}

.result-view-switch.is-preview .result-view-switch-label.is-right {
  color: var(--color-text-tertiary);
  opacity: 0.6;
}

.result-view-switch.is-raw .result-view-switch-thumb {
  transform: translateX(100%);
}

.result-view-switch.is-raw .result-view-switch-label.is-left {
  color: var(--color-text-tertiary);
  opacity: 0.6;
}

.result-view-switch.is-raw .result-view-switch-label.is-right {
  color: var(--color-text-primary);
  transform: scale(1.01);
}

.result-view-switch:focus-visible .result-view-switch-track {
  outline: none;
  border-color: var(--color-border-hover);
  background: var(--color-bg-secondary);
}

.tool-result-error {
  margin-top: 10px;
  color: var(--color-error);
  font-size: 12px;
}

.tool-result-error {
  margin-top: 10px;
  color: #b42318;
  font-size: 12px;
}

/* 思考节点 */
.node-thought {
  padding: var(--spacing-md);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  transition: background-color 0.2s ease;
  margin-bottom: var(--spacing-md);
}

.node-thought.running {
  background: var(--color-bg-tertiary);
}

@keyframes dot-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}

.thought-thinking {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--spacing-sm);
  color: var(--color-text-muted);
  font-size: 0.85rem;
}

.thinking-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-text-muted);
  animation: dotFade 1.4s infinite ease-in-out both;
}

.thinking-dot:nth-child(1) { animation-delay: -0.32s; }
.thinking-dot:nth-child(2) { animation-delay: -0.16s; }
.thinking-dot:nth-child(3) { animation-delay: 0s; }

.thinking-label {
  margin-left: 4px;
  font-style: italic;
}

@keyframes dotFade {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
}

.thought-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.agent-badge {
  padding: 3px 10px;
  border-radius: var(--radius-md);
  font-size: 0.75rem;
  font-weight: 600;
  border: 1px solid var(--color-border);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.badge-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

.badge-status-dot.running {
  background: var(--color-warning);
  animation: dot-breathe 1.5s ease-in-out infinite;
}

.status-dot-fade-enter-active {
  transition: opacity 0.3s ease, transform 0.3s ease, width 0.3s ease, margin-right 0.3s ease;
}

.status-dot-fade-leave-active {
  transition: opacity 0.6s ease, transform 0.6s ease, width 0.6s ease, margin-right 0.6s ease;
}

.status-dot-fade-enter-from,
.status-dot-fade-leave-to {
  opacity: 0;
  transform: scale(0);
  width: 0 !important;
  margin-right: -6px;
}

.round-badge {
  padding: 2px 8px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  border-radius: var(--radius-md);
  font-size: 0.7rem;
  font-weight: 600;
  border: 1px solid var(--color-border);
}

.thought-content {
  margin-top: var(--spacing-sm);
  font-size: 0.9rem;
  line-height: 1.8;
  color: var(--color-text-primary);
  font-weight: 400;
}

.thought-content:empty {
  margin-top: 0;
}

/* 智能体调用节点 */
.node-agent-call {
  /* overflow: hidden; */
  margin-bottom: var(--spacing-md);
  display: flex;
  flex-direction: column;
}


.agent-call-header {
  padding: var(--spacing-sm) 0;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: calc(var(--spacing-md) + 7px);
  transition: background-color 0.2s ease;
  z-index: 10;
  position: relative;
  overflow: visible;
}

.expand-icon {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  transition: transform 0.22s ease-out;
  margin-left: -7px;
  overflow: visible;
}

.expand-icon.expanded {
  transform: rotate(90deg);
}

.expand-icon-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.order-badge {
  font-weight: 700;
  color: var(--color-text-primary);
  font-size: 0.95rem;
}

.status-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.status-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-badge.running {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  border-color: var(--color-border);
}

.status-badge.running::before {
  background: var(--color-warning);
  animation: status-blink 1.2s ease-in-out infinite;
}

@keyframes status-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.status-badge.success {
  background: var(--color-bg-tertiary);
  color: var(--color-success);
  border-color: var(--color-border);
}

.status-badge.success::before {
  background: var(--color-success);
}

.status-badge.error {
  background: var(--color-bg-tertiary);
  color: var(--color-error);
  border-color: var(--color-border);
}

.status-badge.error::before {
  background: var(--color-error);
}

.ctx-ring {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 8px;
}

.ctx-ring svg {
  display: block;
}

/* 预览区 wrapper：折叠时展开(1fr)，展开时收起(0fr) */
.agent-call-preview-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.22s ease-out;
  min-height: 0;
}

.node-agent-call.expanded > .agent-call-preview-wrap {
  grid-template-rows: 0fr;
}

/* 内层必须 overflow: hidden */
.agent-call-preview {
  overflow: hidden;
  box-sizing: border-box;
  min-height: 0;
}

/* grid 折叠容器：只保留高度切换，减少同时做 opacity 带来的卡顿 */
.agent-call-detail-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s ease-out;
  overflow: hidden;
  min-height: 0;
}

.agent-call-detail-wrap.expanded {
  grid-template-rows: 1fr;
}

/* 将裁切留在外层 wrap，避免父级 detail 把嵌套 agent 的 preview 一起裁掉 */
.agent-call-details {
  overflow: visible;
  box-sizing: border-box;
  border-left: 1px dashed var(--color-border);
  min-height: 0;
}

.agent-call-details > .children-container {
  border-left: none;
}

.description {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
}

.result-preview {
  font-size: 0.85rem;
  color: var(--color-text-muted);
  line-height: 1.7;
}

.clamp-box {
  position: relative;
}

.clamp-box.interactive {
  cursor: pointer;
}

/* 预览折叠区：只保留高度过渡，遮罩不参与动画，优先保证流畅 */
.clamp-box .description,
.clamp-box .result-preview {
  overflow: hidden;
  transition: max-height 0.18s ease-out;
}

.clamp-box:not(.expanded) .description,
.clamp-box:not(.expanded) .result-preview {
  -webkit-mask-image: linear-gradient(to bottom, black 58%, transparent 100%);
  mask-image: linear-gradient(to bottom, black 58%, transparent 100%);
}

.clamp-box.expanded .description,
.clamp-box.expanded .result-preview {
  -webkit-mask-image: none;
  mask-image: none;
}

.clamp-fade {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2.5em;
  pointer-events: none;
}

.preview-meta {
  margin-top: 4px;
}

.tool-count-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--color-interactive-subtle);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
  white-space: nowrap;
}

/* 子步骤微缩状态点 */
.substep-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.substep-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-text-muted);
  transition: background-color 0.3s ease;
}

.substep-dot.success {
  background: var(--color-success);
}

.substep-dot.error {
  background: var(--color-error);
}

.substep-dot.running {
  background: var(--color-warning);
  animation: dot-breathe 1.5s ease-in-out infinite;
}

.substep-dot.pending {
  background: var(--color-text-muted);
  opacity: 0.4;
}

.substep-dots-more {
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--color-text-muted);
  margin-left: 1px;
  white-space: nowrap;
}

/* 工具结果智能预览 */
.tool-smart-preview {
  flex: 1;
  min-width: 0;
  font-size: 0.78rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 移动端优化 */
@media (max-width: 767px) {
  /* 思考节点 */
  .node-thought {
    padding: var(--spacing-md);
  }

  .thought-content {
    font-size: 0.85rem;
    line-height: 1.6;
  }

  /* Agent Badge */
  .agent-badge {
    padding: 3px 8px;
    font-size: 0.7rem;
  }

  .round-badge {
    padding: 2px 8px;
    font-size: 0.65rem;
  }

  /* Agent Call Header */
  .agent-call-header {
    gap: var(--spacing-sm);
  }

  .order-badge {
    font-size: 0.85rem;
  }

  .status-badge {
    font-size: 0.7rem;
    padding: 3px 8px;
  }

  /* 描述文本 */
  .description,
  .description-full {
    font-size: 0.85rem;
    line-height: 1.6;
    margin-left: var(--spacing-sm);
  }

  .result-preview {
    font-size: 0.8rem;
    line-height: 1.6;
    padding-left: var(--spacing-md);
  }

  .result-summary {
    margin-left: var(--spacing-sm);
    padding-top: var(--spacing-md);
  }

  .section-header {
    font-size: 0.85rem;
    margin-bottom: var(--spacing-sm);
  }

  .result-content {
    font-size: 0.8rem;
    padding: var(--spacing-md);
  }

  /* 工具调用节点 */
  .tool-header {
    padding: var(--spacing-sm) var(--spacing-md);
    gap: var(--spacing-sm);
  }

  .tool-name {
    font-size: 0.8rem;
  }

  .tool-time {
    font-size: 0.65rem;
    padding: 2px 6px;
  }

  .detail-header {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: 0.7rem;
  }

  .code-tag {
    font-size: 0.6rem;
    padding: 2px 4px;
  }

  .code-wrapper {
    padding: var(--spacing-sm);
  }

  .detail-code {
    font-size: 0.75rem;
    line-height: 1.5;
    max-height: 300px;
  }

  /* 子节点容器 */
  .children-container {
    margin-top: var(--spacing-sm);
    padding-left: var(--spacing-sm);
  }

  /* 展开/收起按钮 */
  .trigger-content {
    width: 36px;
    height: 36px;
  }

  .icon-up,
  .icon-down {
    width: 28px;
    height: 28px;
  }
  .expand-icon {
    margin-left: -6px;
    width: 14px;
    height: 14px;
  }
}

@media (max-width: 480px) {
  .expand-icon {
    margin-left: -5px;
    width: 12px;
    height: 12px;
  }
}

.description-full {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
  margin-bottom: var(--subtasks-padding);
  margin-left: var(--subtasks-padding);
}

.result-summary {
  margin-top: var(--spacing-lg);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border);
  margin-left: var(--subtasks-padding);
}

.section-header {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--color-text-muted);
  margin-bottom: var(--spacing-sm);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.result-content {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-md);
  white-space: pre-wrap;
  font-family: var(--font-mono);
  overflow-y: auto;
}

/* 外部展开/折叠按钮 */
.collapse-trigger-external {
  margin-top: -12px;
  margin-bottom: var(--spacing-sm);
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  animation: fadeIn 0.3s forwards 0.3s;
}

.expand-trigger-external {
  margin-top: -12px;
  margin-bottom: var(--spacing-sm);
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  animation: fadeIn 0.3s forwards;
}

.trigger-content {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  color: var(--color-brand-accent-light);
  transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  border-radius: 50%;
  cursor: pointer;
}

.trigger-content:hover {
  transform: scale(1.15);
  color: var(--color-brand-accent);
}

.icon-up {
  width: 32px;
  height: 32px;
}

.icon-down {
  width: 32px;
  height: 32px;
  transform: rotate(180deg);
  animation: pulse-scale-rotate 2s infinite ease-in-out;
}

@keyframes fadeIn {
  to { opacity: 1; }
}

@keyframes pulse-scale-rotate {
  0%, 100% {
    transform: rotate(180deg) scale(1);
  }
  50% {
    transform: rotate(180deg) scale(1.1);
  }
}

/* 工具调用节点 */
.node-tool-call {
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  overflow: visible;
  transition: background-color 0.2s ease;
  margin-bottom: var(--spacing-sm);
}

/* .node-tool-call.expanded {
  background: var(--color-bg-primary);
} */

.tool-header {
  display: flex;
  align-items: center;
  padding: var(--spacing-md);
  cursor: pointer;
  gap: var(--spacing-md);
}

.tool-status-indicator {
  position: relative;
  width: 10px;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-muted);
  z-index: 2;
}

.status-ring {
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 1.5px solid transparent;
  opacity: 0.5;
}

.node-tool-call.success .status-dot {
  background: var(--color-success);
}

.node-tool-call.success .status-ring {
  border-color: var(--color-success);
}

.node-tool-call.error .status-dot {
  background: var(--color-error);
}

.node-tool-call.error .status-ring {
  border-color: var(--color-error);
}

.node-tool-call.running .status-dot {
  background: var(--color-warning);
  animation: dot-breathe 1.5s ease-in-out infinite;
}

.node-tool-call.running .status-ring {
  border-color: var(--color-warning);
  animation: dot-breathe 1.5s ease-in-out infinite;
}

.tool-name {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.02em;
  white-space: nowrap;
}

.tool-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-left: auto;
  flex-shrink: 0;
}

.tool-time {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--color-text-muted);
  background: var(--color-bg-elevated);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
}

.tool-expand-btn {
  color: var(--color-text-muted);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  align-items: center;
  will-change: transform;
}

.tool-expand-btn.rotated {
  transform: rotate(180deg);
}

.tool-details {
  overflow: hidden;
  box-sizing: border-box;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-primary);
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}

/* grid 折叠动画：替代 max-height 方案 */
.tool-details-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.25s ease;
  opacity: 0;
}

.tool-details-wrap.expanded {
  grid-template-rows: 1fr;
  opacity: 1;
}

.detail-block {
  padding: 0;
}

.detail-header {
  padding: var(--spacing-sm) var(--spacing-md);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--spacing-sm);
  background: var(--color-bg-primary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.detail-header > span:first-child {
  min-width: 0;
  flex: 1;
}

.code-tag {
  font-size: 0.65rem;
  padding: 2px 6px;
  background: var(--color-interactive-subtle);
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  font-weight: 700;
  letter-spacing: 0.05em;
}

.result-tag {
  background: var(--color-success-bg);
  color: var(--color-success);
}

.code-wrapper {
  padding: var(--spacing-md);
  background: var(--color-bg-primary);
  border-radius: var(--radius-lg);
}

.detail-code {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  line-height: 1.7;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
  overflow-y: auto;
}

.result-code {
  color: var(--color-text-primary);
}

/* 子节点容器 */
.children-container {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-top: var(--subtasks-padding);
  padding-left: var(--subtasks-padding);
  border-left: 1px dashed var(--color-border);
}

/* 动画 */
@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}



/* ── request_user_input 专属样式 ── */
.user-input-tool .tool-status-indicator .status-dot {
  background: var(--color-accent, #6366f1);
}

.user-input-tool.running .tool-status-indicator .status-ring {
  border-color: var(--color-accent, #6366f1);
}

.user-input-prompt-block .detail-header {
  border-left-color: var(--color-accent, #6366f1);
}

.user-input-prompt {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--color-text-primary);
  padding: var(--spacing-xs) var(--spacing-md) var(--spacing-sm);
  font-weight: 500;
}

.user-input-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  /* margin-top: 8px; */
  padding: var(--spacing-xs) var(--spacing-md) var(--spacing-sm);
}

.option-chip {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 0.8125rem;
  background: var(--color-bg-tertiary, rgba(99, 102, 241, 0.1));
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}

.user-input-answer-block .detail-header {
  border-left-color: var(--color-success);
}

.user-input-answer {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--color-text-primary);
  padding: var(--spacing-xs) var(--spacing-md) var(--spacing-sm);
  white-space: pre-wrap;
  word-break: break-word;
}

.user-tag {
  background: rgba(var(--color-success-rgb), 0.15) !important;
  color: var(--color-success) !important;
  border: 1px solid rgba(var(--color-success-rgb), 0.3);
}

.user-input-waiting {
  font-size: 0.875rem;
  color: var(--color-text-secondary);
  font-style: italic;
  padding: var(--spacing-md);
}
</style>
