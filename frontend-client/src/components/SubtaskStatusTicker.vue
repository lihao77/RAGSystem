<template>
  <div class="subtask-status-ticker glass-card" :class="{ 'is-expanded': expanded }">
    <div class="ticker-content" >
      <!-- 动态滚动区域 -->
      <div class="ticker-scroll-area">
        <transition-group name="ticker-item">
           <!-- 当前正在执行的任务/工具 -->
           <div v-if="currentActivity" key="current" class="ticker-item active">
             <span class="agent-badge" :class="getAgentBadgeClass(currentActivity.agent_display_name)">{{ currentActivity.agent_display_name }}</span>
             <span class="action-text">
               <span v-if="currentActivity.tool_name" class="tool-name">🛠️ {{ currentActivity.tool_name }}</span>
               <span v-else>{{ currentActivity.description }}</span>
             </span>
             <div class="loading-dots">
               <span>.</span><span>.</span><span>.</span>
             </div>
           </div>

           <!-- 运行中但无活跃工具：入口 Agent 已启动 -->
           <div v-else-if="running && hasRunningRootExecution" key="run" class="ticker-item active">
             <span class="agent-badge" :class="getAgentBadgeClass(rootExecutionAgentLabel)">{{ rootExecutionAgentLabel }}</span>
             <span class="action-text">执行中</span>
             <div class="loading-dots">
               <span>.</span><span>.</span><span>.</span>
             </div>
           </div>

           <!-- 运行中但无活跃工具：正在推理 -->
           <div v-else-if="running" key="intent" class="ticker-item active">
            <span class="agent-badge" :class="getAgentBadgeClass(rootExecutionAgentLabel)">{{ rootExecutionAgentLabel }}</span>
             <span class="action-text">正在生成意图</span>
             <div class="loading-dots">
               <span>.</span><span>.</span><span>.</span>
             </div>
           </div>

           <!-- 最近完成的任务（仅 running=false 时显示，即任务真正结束后） -->
           <div v-else-if="lastCompletedTask" key="last" class="ticker-item completed">
             <span class="agent-badge success" :class="getAgentBadgeClass(lastCompletedTask.agent_display_name)">
               <IconCheck :size="12" />
               {{ lastCompletedTask.agent_display_name }}
             </span>
             <span class="action-text">任务已完成</span>
           </div>

           <!-- 历史执行树未加载 -->
           <div v-else-if="!running && loading" key="loading" class="ticker-item idle">
             <span class="action-text">正在加载执行过程...</span>
           </div>

           <div v-else-if="!running && hasExecution" key="lazy" class="ticker-item idle">
             <span class="action-text">展开后加载执行过程</span>
           </div>

           <!-- 初始状态 -->
           <div v-else key="idle" class="ticker-item idle">
             <span class="action-text">暂无执行过程</span>
           </div>
        </transition-group>
      </div>

      <!-- 切换详情按钮 -->
      <UiButton class="toggle-details-btn" variant="ghost" size="compact" @click="$emit('toggle-view')" :title="expanded ? '收起详情' : '显示详细执行过程'">
        <!-- <span class="icon">{{ expanded ? '🔼' : '👁️' }}</span> -->
        <span class="label">{{ expanded ? '收起' : '展开' }}</span>
      </UiButton>
    </div>

    <!-- 进度条 -->
    <!-- <div class="progress-bar-container" v-if="totalTasks > 0">
      <div class="progress-bar" :style="{ width: `${progressPercentage}%` }"></div>
    </div> -->
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { getAgentBadgeClass } from '../utils/agentBadge';
import IconCheck from './icons/IconCheck.vue';
import { UiButton } from './ui';

const props = defineProps({
  executionTree: {
    type: Object,
    default: () => ({ root: null, steps: [] })
  },
  expanded: {
    type: Boolean,
    default: false
  },
  running: {
    type: Boolean,
    default: false
  },
  hasExecution: {
    type: Boolean,
    default: false
  },
  loading: {
    type: Boolean,
    default: false
  }
});

defineEmits(['toggle-view']);

const resolveAgentLabel = (agent) => agent?.displayName || agent?.agentId || agent?.agent_display_name || '';

const flattenAgents = (executionTree) => {
  const result = [];
  if (!executionTree?.root) return result;
  const stack = [executionTree.root];
  while (stack.length > 0) {
    const agent = stack.shift();
    if (!agent) continue;
    result.push(agent);
    if (Array.isArray(agent.children) && agent.children.length > 0) {
      stack.push(...agent.children);
    }
  }
  return result;
};

const findRunningTool = (agent) => {
  for (const round of agent.rounds || []) {
    for (const toolCall of round.toolCalls || []) {
      if (toolCall.status === 'running') return toolCall;
    }
  }
  return null;
};

const allAgents = computed(() => flattenAgents(props.executionTree));
const rootAgent = computed(() => props.executionTree?.root || null);

const currentActivity = computed(() => {
  // 非根 running agent（子 agent 执行中）
  const runningChild = allAgents.value.find(a => a !== rootAgent.value && a.status === 'running');
  if (runningChild) {
    const runningTool = findRunningTool(runningChild);
    return {
      agent_display_name: resolveAgentLabel(runningChild),
      description: runningChild.task || '',
      tool_name: runningTool ? runningTool.toolName : null,
    };
  }
  // 根 agent 的 running tool
  const root = rootAgent.value;
  if (root) {
    const runningTool = findRunningTool(root);
    if (runningTool) {
      return {
        agent_display_name: resolveAgentLabel(root),
        description: null,
        tool_name: runningTool.toolName,
      };
    }
  }
  return null;
});

const hasRunningRootExecution = computed(() => {
  const root = rootAgent.value;
  if (!root) return false;
  return root.status === 'running' || Boolean(findRunningTool(root));
});

const rootExecutionAgentLabel = computed(() => {
  const root = rootAgent.value;
  return resolveAgentLabel(root) || 'orchestrator_agent';
});

const lastCompletedTask = computed(() => {
  const completed = allAgents.value.filter(a => a !== rootAgent.value && (a.status === 'succeeded' || a.status === 'failed'));
  if (completed.length > 0) {
    const last = completed[completed.length - 1];
    return {
      agent_display_name: resolveAgentLabel(last),
      description: last.task || '',
      status: last.status === 'failed' ? 'error' : 'success',
    };
  }
  // 根 agent 的最后完成工具
  const root = rootAgent.value;
  if (root) {
    const rounds = root.rounds || [];
    for (let i = rounds.length - 1; i >= 0; i -= 1) {
      const tools = rounds[i]?.toolCalls || [];
      if (tools.length > 0) {
        const lastTool = tools[tools.length - 1];
        if (lastTool.status === 'succeeded') {
          return { agent_display_name: rootExecutionAgentLabel.value, description: lastTool.toolName, status: 'success' };
        }
      }
    }
    if (!props.running && (rounds.length > 0 || (root.children || []).length > 0)) {
      return { agent_display_name: rootExecutionAgentLabel.value, status: 'success' };
    }
  }
  return null;
});

</script>

<style scoped>
.subtask-status-ticker {
  overflow: hidden;
  background-color: transparent;
  border: 1px solid transparent;
  /* margin: var(--spacing-sm) 0; */
  /* box-shadow: var(--shadow-sm); */
  /* 增加 transition-property 和 duration 以匹配展开动画 */
  transition: border-radius 0.35s var(--ease-material),
              background 0.3s,
              border 0.3s,
              box-shadow 0.3s,
              margin 0.35s var(--ease-material) !important;
  position: relative;
  z-index: 2; /* Ensure it stays on top */
}

.subtask-status-ticker.is-expanded {
  border-radius: var(--radius-lg) var(--radius-lg) 0 0; /* 上方圆角，下方直角 */
  /* border-bottom: 1px solid rgba(255, 255, 255, 0.05); */
  /* margin-bottom: 0; */
  border: 1px solid var(--color-border);
  background: var(--glass-bg); /* 保持一致的背景 */
  border-bottom: 1px solid transparent;
  box-shadow: none; /* 移除阴影，让整体容器统一投影 */
  /* position: sticky;
  top: calc(-1 * var(--radius-lg));
  z-index: 3; */
}

.ticker-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  height: 48px;
  transition: padding 0.35s var(--ease-material);
}

/* 折叠状态：左右 padding 置为 0 */
.subtask-status-ticker:not(.is-expanded) .ticker-content {
  padding-left: 0;
}

.ticker-scroll-area {
  flex: 1;
  overflow: hidden;
  position: relative;
  height: 100%;
  min-height: 28px;
  display: flex;
  align-items: center;
}

.ticker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
  width: 100%;
  min-width: 0;
}

.agent-badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
  border: 1px solid rgba(var(--color-brand-accent-light-rgb), 0.2);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.agent-badge.success {
    background: var(--color-success-bg);
    color: var(--color-success);
    border-color: var(--color-agent-success-border);
}

.action-text {
  font-size: 0.9rem;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.tool-name {
    color: var(--color-warning);
    font-family: var(--font-mono);
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 260px;
}

.loading-dots {
  display: flex;
  gap: 2px;
}

.loading-dots span {
  animation: dotFade 1.4s infinite ease-in-out both;
  color: var(--color-text-muted);
}

.loading-dots span:nth-child(1) { animation-delay: -0.32s; }
.loading-dots span:nth-child(2) { animation-delay: -0.16s; }

@keyframes dotFade {
  0%, 80%, 100% { opacity: 0; }
  40% { opacity: 1; }
}

.toggle-details-btn {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  border-radius: var(--radius-full);
  padding: 4px 12px;
  font-size: 0.8rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s;
  margin-left: 12px;
  flex-shrink: 0;
}

.toggle-details-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  border-color: var(--color-border-hover);
}

/* .progress-bar-container {
    height: 2px;
    background: var(--color-bg-tertiary);
    width: 100%;
    position: absolute;
    bottom: 0;
    left: 0;
} */

.progress-bar {
    height: 100%;
    background: var(--color-interactive);
    transition: width 0.5s ease;
    box-shadow: 0 0 10px var(--color-interactive);
}

/* Transitions */
.ticker-item-enter-active {
  transition: opacity var(--duration-base), transform var(--duration-base);
  position: absolute;
}

.ticker-item-leave-active {
  /* 离场极速消失，避免切换瞬间产生视觉闪烁 */
  transition: opacity 0.05s ease;
  position: absolute;
}

.ticker-item-enter-from {
  opacity: 0;
  transform: translateY(12px);
}

.ticker-item-leave-to {
  opacity: 0;
  transform: translateY(0);
}

/* 移动端优化 */
@media (max-width: 767px) {
  .ticker-content {
    padding: 6px 12px;
    height: 44px;
  }

  .agent-badge {
    font-size: 0.7rem;
    padding: 2px 6px;
  }

  .action-text {
    font-size: 0.85rem;
  }

  .tool-name {
    font-size: 0.8rem;
  }

  .toggle-details-btn {
    padding: 3px 10px;
    font-size: 0.75rem;
    margin-left: 8px;
  }

  .label {
    display: inline;
  }
}

@media (max-width: 480px) {
  .ticker-content {
    padding: 6px 10px;
    height: 40px;
  }

  .agent-badge {
    font-size: 0.65rem;
    padding: 2px 5px;
  }

  .action-text {
    font-size: 0.8rem;
  }

  .tool-name {
    font-size: 0.75rem;
  }

  .toggle-details-btn {
    padding: 3px 8px;
    font-size: 0.7rem;
    margin-left: 6px;
  }

  /* 小屏手机上可能需要隐藏部分文字 */
  .ticker-item {
    gap: 6px;
  }
}
</style>
