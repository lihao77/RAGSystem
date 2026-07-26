<template>
  <div v-if="hasContextPopover" class="session-context-info">
    <Popover v-model:open="metaExpanded">
      <PopoverTrigger as-child>
        <Button
          variant="ghost"
          :size="showSummary && compactSummary ? 'sm' : 'icon'"
          class="session-context-summary"
          :class="{ 'is-expanded': metaExpanded }"
          :title="summaryTitle"
          aria-label="查看会话与执行信息"
          :aria-expanded="metaExpanded ? 'true' : 'false'"
        >
          <Info data-icon="inline-start" aria-hidden="true" />
          <span v-if="showSummary && compactSummary" class="session-context-summary__text">
            {{ compactSummary }}
          </span>
          <span v-if="showStatusChip" class="session-context-status-dot" :class="`tone-${statusTone}`" aria-hidden="true"></span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        class="session-context-popover w-[420px] max-h-[360px]"
        :align="align"
        :side="side"
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
          <div v-if="workspaceDisplay" class="session-meta-item">
            <span class="session-meta-label">工作区</span>
            <span class="session-meta-value session-meta-value--path" :title="workspaceDisplay">{{ workspaceDisplay }}</span>
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
import { Info } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';

const props = defineProps({
  currentSessionId: { type: String, default: '' },
  team: { type: String, default: '' },
  entryAgent: { type: String, default: '' },
  workspaceRoot: { type: String, default: '' },
  workspaceDisplay: { type: String, default: '' },
  executionStatusText: { type: String, default: '' },
  showExecutionStatus: { type: Boolean, default: false },
  executionObservability: { type: Object, default: null },
  showSummary: { type: Boolean, default: false },
  side: { type: String, default: 'top' },
  align: { type: String, default: 'end' },
});

const metaExpanded = ref(false);

const hasContextItems = computed(() => Boolean(
  props.team || props.entryAgent || props.workspaceDisplay || props.workspaceRoot,
));
const showStatusChip = computed(() => Boolean(props.currentSessionId && props.showExecutionStatus));
const hasContextPopover = computed(() => hasContextItems.value || showStatusChip.value);
const workspaceSummary = computed(() => {
  if (props.workspaceDisplay) return props.workspaceDisplay;
  const parts = props.workspaceRoot.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || props.workspaceRoot;
});
const compactSummary = computed(() => [props.team, workspaceSummary.value].filter(Boolean).join(' · '));
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
  if (props.workspaceDisplay) lines.push(`工作区: ${props.workspaceDisplay}`);
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
  min-width: 0;
  max-width: 260px;
}

.session-context-summary__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

@media (max-width: 1100px) {
  .session-context-summary__text {
    display: none;
  }
}
</style>
