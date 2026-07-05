<template>
  <div v-if="hasContextPopover" class="session-context-info">
    <Popover v-model:open="metaExpanded">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="session-context-summary"
          :class="{ 'is-expanded': metaExpanded }"
          :title="summaryTitle"
          aria-label="查看会话与执行信息"
          :aria-expanded="metaExpanded ? 'true' : 'false'"
        >
          <svg class="session-context-summary__icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8" />
            <path d="M12 10.5v5.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <path d="M12 7.25h.01" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" />
          </svg>
          <span v-if="showStatusChip" class="session-context-status-dot" :class="`tone-${statusTone}`" aria-hidden="true"></span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        class="session-context-popover w-[420px] max-h-[360px]"
        align="end"
        side="top"
        :side-offset="12"
      >
        <div v-if="hasContextItems" class="session-meta-section">
          <div class="session-meta-section-title">会话信息</div>
          <div v-if="team" class="session-meta-item">
            <span class="session-meta-label">Team</span>
            <span class="session-meta-value">{{ team }}</span>
          </div>
          <div v-if="entryAgent" class="session-meta-item">
            <span class="session-meta-label">Agent</span>
            <span class="session-meta-value">{{ entryAgent }}</span>
          </div>
          <div v-if="workspaceRoot" class="session-meta-item">
            <span class="session-meta-label">目录</span>
            <span class="session-meta-value session-meta-value--path" :title="workspaceRoot">{{ workspaceRoot }}</span>
          </div>
        </div>

        <div v-if="showStatusChip" class="session-meta-section">
          <div class="session-meta-section-title">执行状态</div>
          <div class="session-meta-item">
            <span class="session-meta-label">状态</span>
            <span class="session-meta-value">{{ executionStatusText || '空闲' }}</span>
          </div>
          <div v-if="executionObservability?.execution_kind" class="session-meta-item">
            <span class="session-meta-label">类型</span>
            <span class="session-meta-value">{{ executionObservability.execution_kind }}</span>
          </div>
          <div v-if="executionObservability?.task_id" class="session-meta-item">
            <span class="session-meta-label">Task</span>
            <span class="session-meta-value session-meta-value--path" :title="executionObservability.task_id">{{ executionObservability.task_id }}</span>
          </div>
          <div v-if="executionObservability?.run_id" class="session-meta-item">
            <span class="session-meta-label">Run</span>
            <span class="session-meta-value session-meta-value--path" :title="executionObservability.run_id">{{ executionObservability.run_id }}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';

const props = defineProps({
  currentSessionId: { type: String, default: '' },
  team: { type: String, default: '' },
  entryAgent: { type: String, default: '' },
  workspaceRoot: { type: String, default: '' },
  executionStatusText: { type: String, default: '' },
  showExecutionStatus: { type: Boolean, default: false },
  executionObservability: { type: Object, default: null },
});

const metaExpanded = ref(false);

const hasContextItems = computed(() => Boolean(props.team || props.entryAgent || props.workspaceRoot));
const showStatusChip = computed(() => Boolean(props.currentSessionId && props.showExecutionStatus));
const hasContextPopover = computed(() => hasContextItems.value || showStatusChip.value);
const statusTone = computed(() => {
  const text = props.executionStatusText || '';
  if (text.includes('失败') || text.includes('异常')) return 'error';
  if (text.includes('中断') || text.includes('停止')) return 'warning';
  if (text.includes('完成')) return 'success';
  if (text.includes('运行') || text.includes('等待') || text.includes('输出') || text.includes('重试') || text.includes('执行')) return 'running';
  return 'idle';
});
const summaryTitle = computed(() => {
  const lines = [];
  if (props.team) lines.push(`Team: ${props.team}`);
  if (props.entryAgent) lines.push(`Agent: ${props.entryAgent}`);
  if (props.workspaceRoot) lines.push(`目录: ${props.workspaceRoot}`);
  if (showStatusChip.value) lines.push(`状态: ${props.executionStatusText || '空闲'}`);
  return lines.join('\n') || '会话信息';
});
</script>

<style scoped>
.session-context-info {
  position: relative;
  flex-shrink: 0;
}

.session-context-summary {
  position: relative;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0.72;
  transition:
    opacity var(--transition-fast),
    color var(--transition-fast),
    background var(--transition-fast),
    border-color var(--transition-fast),
    transform var(--transition-fast);
}

.session-context-summary:hover,
.session-context-summary.is-expanded {
  opacity: 1;
  color: var(--color-text-secondary);
  background: var(--color-hover-overlay);
  border-color: transparent;
}

.session-context-summary:active {
  opacity: 0.6;
}

.session-context-summary__icon {
  width: 18px;
  height: 18px;
}

.session-context-status-dot {
  --status-tone: var(--color-text-muted);
  --status-tone-rgb: var(--color-text-muted-rgb, 142, 142, 147);
  position: absolute;
  right: 6px;
  top: 6px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--status-tone);
  opacity: 0.76;
}

.session-context-status-dot.tone-running {
  --status-tone: var(--color-brand-accent);
  --status-tone-rgb: var(--color-brand-accent-rgb);
}

.session-context-status-dot.tone-warning {
  --status-tone: var(--color-warning);
  --status-tone-rgb: var(--color-warning-rgb);
}

.session-context-status-dot.tone-error {
  --status-tone: var(--color-error);
  --status-tone-rgb: var(--color-error-rgb);
}

.session-context-status-dot.tone-success {
  --status-tone: var(--color-success);
  --status-tone-rgb: var(--color-success-rgb);
}

/* shadcn PopoverContent 默认带 fixed/portal/z-index/动画，
   这里只补视觉（padding/bg/border/radius/gap/overflow） */
.session-context-popover {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--color-bg-secondary);
  border-color: var(--color-border);
  box-shadow: var(--shadow-lg);
  overflow-y: auto;
  overflow-x: hidden;
}

.session-meta-section {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.session-meta-section + .session-meta-section {
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.session-meta-section-title {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-weight: 700;
}

.session-meta-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.session-meta-label {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.session-meta-value {
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.session-meta-value--path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (prefers-reduced-motion: reduce) {
  .session-context-summary {
    transition-duration: 1ms;
  }
}
</style>
