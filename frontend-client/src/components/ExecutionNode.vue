<template>
  <div class="execution-node" :class="node.type">
    <!-- 思考节点 -->
    <div v-if="node.type === 'thought'" class="node-thought" :class="{ running: isRunning }">
      <div class="thought-header" v-if="node.round">
        <span class="agent-badge" :class="getAgentClass(node.agent)">
          {{ node.agent_display_name || node.agent }}
        </span>
        <span class="round-badge">轮次 {{ node.round }}</span>
      </div>
      <div class="thought-content">{{ node.thought }}</div>
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
        <span class="agent-badge" :class="getAgentClass(node.agent_name)">
          {{ node.agent_display_name || node.agent_name }}
        </span>
        <span v-if="node.order" class="order-badge">
          步骤 {{ getStepLabel(node) }}
        </span>
        <span class="status-badge" :class="node.status">
          {{ getStatusText(node.status) }}
        </span>
        <!-- 上下文用量圆形进度 -->
        <span v-if="node.ctx && node.ctx.max > 0" class="ctx-ring" :title="`上下文: ${node.ctx.used.toLocaleString()} / ${node.ctx.max.toLocaleString()} tokens`">
          <svg width="20" height="20" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="8" fill="none" stroke="#e0e0e0" stroke-width="2.5" />
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
            />
          </div>

          <!-- 结果摘要 -->
          <div v-if="node.result_summary" class="result-summary">
            <div class="section-header">📋 执行结果</div>
            <div class="result-content">{{ node.result_summary }}</div>
          </div>
        </div>
      </div>

      <!-- 预览区（折叠时可见，展开时收起） -->
      <div class="agent-call-preview-wrap">
        <div class="agent-call-preview">
          <div class="description">{{ node.description }}</div>
          <div v-if="node.result_summary" class="result-preview">
            {{ node.result_summary }}
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

      <transition name="slide-fade">
        <div v-show="localExpanded" class="tool-details">
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
            <div v-if="node.result && node.result !== '（已取消）'" class="detail-block user-input-answer-block">
              <div class="detail-header">
                <span>用户回答</span>
                <span class="code-tag user-tag">USER</span>
              </div>
              <div class="user-input-answer">{{ node.result }}</div>
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

            <div v-if="node.result" class="detail-block">
              <div class="detail-header">
                <span>执行结果</span>
                <span class="code-tag result-tag">RESULT</span>
              </div>
              <div class="code-wrapper">
                <pre class="detail-code result-code">{{ JSON.stringify(node.result, null, 2) }}</pre>
              </div>
            </div>
          </template>
        </div>
      </transition>
    </div>

    <!-- 递归渲染子节点（仅用于 thought 节点） -->
    <div v-if="node.type === 'thought' && node.children && node.children.length > 0" class="children-container">
      <ExecutionNode
        v-for="(child, index) in node.children"
        :key="index"
        :node="child"
        :level="level + 1"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, defineProps } from 'vue';

const props = defineProps({
  node: {
    type: Object,
    required: true
  },
  level: {
    type: Number,
    default: 0
  }
});

// request_user_input 节点默认展开（让用户立即看到提问内容）
const defaultExpanded = props.node.expanded !== undefined
  ? props.node.expanded
  : props.node.tool_name === 'request_user_input';
const localExpanded = ref(defaultExpanded);

// 工具名展示映射
const TOOL_DISPLAY_NAMES = {
  'request_user_input': '请求用户输入',
  'activate_skill': '激活 Skill',
  'load_skill_resource': '加载 Skill 资源',
  'execute_skill_script': '执行 Skill 脚本',
};

const toolDisplayName = computed(() => {
  const name = props.node.tool_name || '';
  return TOOL_DISPLAY_NAMES[name] || name;
});

const isRunning = computed(() => {
  if (props.node.type === 'thought' && props.node.children) {
    return props.node.children.some(child => child.status === 'running');
  }
  return false;
});

const getAgentClass = (agentName) => {
  if (!agentName) return '';
  if (agentName.includes('master')) return 'master';
  if (agentName.includes('qa')) return 'qa';
  if (agentName.includes('analysis')) return 'analysis';
  return 'default';
};

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
    'running': '⏳ 执行中',
    'success': '✅ 完成',
    'error': '❌ 失败'
  };
  return statusMap[status] || status;
};

// agent_call 折叠/展开，纯 CSS grid-template-rows 动画，无需 JS 测量高度
const toggleExpanded = () => {
  localExpanded.value = !localExpanded.value;
};
</script>

<style scoped>
.execution-node {
  animation: fadeInUp 0.3s ease-out;
}

/* 思考节点 */
.node-thought {
  padding: var(--spacing-lg);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-lg);
  border-left: 3px solid var(--color-success);
  transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  margin-bottom: var(--spacing-md);
  will-change: background-color, border-color, box-shadow;
}

.node-thought.running {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-warning);
  box-shadow: -2px 0 20px var(--color-interactive-glow);
}

.thought-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.agent-badge {
  padding: 4px 12px;
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  border: 1px solid var(--color-border);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.agent-badge.master {
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
}

.agent-badge.qa {
  background: rgba(59, 130, 246, 0.15);
  color: #60a5fa;
}

.agent-badge.analysis {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
}

.agent-badge.default {
  background: rgba(156, 163, 175, 0.15);
  color: #9ca3af;
}

.round-badge {
  padding: 3px 10px;
  background: var(--color-interactive-subtle);
  color: var(--color-text-secondary);
  border-radius: var(--radius-full);
  font-size: 0.7rem;
  font-weight: 700;
  border: 1px solid var(--color-glass-border);
  letter-spacing: 0.03em;
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
  gap: var(--spacing-md);
  transition: background-color 0.2s ease;
  will-change: background-color;
  z-index: 10;
  position: relative;
  /* padding-left: -4px; */
  overflow: visible;
} 

.expand-icon {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform;
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
  font-size: 0.8rem;
  font-weight: 700;
  padding: 4px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-left: auto;
}

.status-badge.running {
  background: var(--color-warning-bg);
  color: var(--color-warning);
  border-color: var(--color-warning);
}

.status-badge.success {
  background: var(--color-success-bg);
  color: var(--color-success);
  border-color: var(--color-success);
}

.status-badge.error {
  background: var(--color-error-bg);
  color: var(--color-error);
  border-color: var(--color-error);
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
  transition: grid-template-rows 0.4s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.3s ease;
  opacity: 1;
}

.node-agent-call.expanded .agent-call-preview-wrap {
  grid-template-rows: 0fr;
  opacity: 0;
}

/* 内层必须 overflow: hidden */
.agent-call-preview {
  overflow: hidden;
  box-sizing: border-box;
}

/* grid 折叠容器：用 grid-template-rows 0fr→1fr 实现无需知道高度的平滑展开 */
.agent-call-detail-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.4s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.3s ease;
  opacity: 0;
}

.agent-call-detail-wrap.expanded {
  grid-template-rows: 1fr;
  opacity: 1;
}

/* 内层必须 overflow: hidden，才能让 0fr 时内容真正不可见 */
.agent-call-details {
  overflow: hidden;
  box-sizing: border-box;
  border-left: 2px solid var(--color-border);
}

.agent-call-details > .children-container {
  border-left: none;
}

.description {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
  margin-bottom: var(--spacing-sm);
}

.result-preview {
  font-size: 0.85rem;
  color: var(--color-text-muted);
  padding-left: var(--spacing-lg);
  border-left: 2px solid var(--color-border);
  line-height: 1.7;
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
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
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
  margin-bottom: var(--spacing-md);
  margin-left: var(--spacing-md);
}

.result-summary {
  margin-top: var(--spacing-lg);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border);
  margin-left: var(--subtasks-padding);
}

.section-header {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--color-text-primary);
  margin-bottom: var(--spacing-md);
}

.result-content {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
  padding: var(--spacing-lg);
  background: var(--color-success-bg);
  border-left: 3px solid var(--color-success);
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
  will-change: background-color;
}

.node-tool-call.running {
  border: 1px solid var(--color-warning);
  box-shadow: 0 0 0 1px var(--color-warning);
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
}

.node-tool-call.running .status-ring {
  border-color: var(--color-warning);
  border-top-color: transparent;
  animation: spin 1s linear infinite;
}

.tool-name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
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
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-app);
  border-radius: 0 0 var(--radius-md) var(--radius-md);
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
  background: var(--color-bg-app);
  text-transform: uppercase;
  letter-spacing: 0.05em;
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
  background: var(--color-bg-app);
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
  border-left: 2px solid var(--color-border);
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

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.3s ease;
  max-height: 600px;
  opacity: 1;
  will-change: max-height, opacity;
}

.slide-fade-enter-from,
.slide-fade-leave-to {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
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
  margin-top: 8px;
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
  border-left-color: #22c55e;
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
  background: rgba(34, 197, 94, 0.15) !important;
  color: #22c55e !important;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.user-input-waiting {
  font-size: 0.875rem;
  color: var(--color-text-secondary);
  font-style: italic;
  padding: 4px 0;
}
</style>
