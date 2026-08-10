<template>
  <section class="runtime-section">
    <header class="runtime-section__head">
      <span class="runtime-section__icon" :class="{ 'is-live': taskState.runningCount }">
        <ListTodo />
      </span>
      <div class="runtime-section__titles">
        <h3 class="runtime-section__title">后台任务</h3>
        <p class="runtime-section__subtitle">当前会话的持久后台执行</p>
      </div>
      <span v-if="taskState.runningCount" class="runtime-section__status">
        <span class="status-dot status-dot--live" />
        {{ taskState.runningCount }} 运行中
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        :disabled="taskState.loading || taskState.cancelling"
        aria-label="刷新后台任务"
        title="刷新后台任务"
        @click="taskState.loadTasks()"
      >
        <RefreshCw data-icon="inline-start" :class="cn({ 'animate-spin': taskState.loading })" />
      </Button>
    </header>

    <div class="runtime-filter-bar">
      <ToggleGroup
        type="single"
        size="sm"
        :model-value="taskState.filter"
        class="runtime-task-filter"
        aria-label="后台任务筛选"
        @update:model-value="handleFilterChange"
      >
        <ToggleGroupItem value="running" aria-label="只看运行中的后台任务">
          运行中
          <Badge variant="secondary" class="runtime-filter-count">{{ taskState.runningCount }}</Badge>
        </ToggleGroupItem>
        <ToggleGroupItem value="all" aria-label="查看全部后台任务">
          全部
          <Badge variant="secondary" class="runtime-filter-count">{{ taskState.tasks.length }}</Badge>
        </ToggleGroupItem>
      </ToggleGroup>
      <Button
        v-if="taskState.selectedCancellableTasks.length"
        variant="ghost"
        size="sm"
        class="runtime-cancel-selected"
        :disabled="taskState.cancelling"
        @click="taskState.cancelSelected"
      >
        <LoaderCircle v-if="taskState.cancelling" data-icon="inline-start" class="animate-spin" />
        <Ban v-else data-icon="inline-start" />
        取消所选 {{ taskState.selectedCancellableTasks.length }}
      </Button>
    </div>

    <EmptyState
      v-if="taskState.error && !taskState.tasks.length"
      row
      tone="error"
      :title="taskState.error"
      class="runtime-empty"
    />

    <EmptyState
      v-else-if="!taskState.filteredTasks.length"
      row
      :title="taskState.loading ? '正在加载后台任务' : taskState.filter === 'running' ? '暂无运行中的后台任务' : '暂无后台任务记录'"
      class="runtime-empty"
    />

    <TooltipProvider v-else :delay-duration="150">
      <ul class="runtime-task-list">
        <li
          v-for="task in taskState.filteredTasks"
          :key="taskId(task)"
          class="runtime-task"
          :class="{ 'is-selected': taskState.selectedTaskIds.includes(taskId(task)) }"
        >
          <span
            class="runtime-task__dot"
            :class="{ 'is-live': task.status === 'running' }"
            :style="{ '--dot-color': statusToneColor(task.status) }"
            :title="statusLabel(task.status)"
          />
          <div class="runtime-task__main">
            <p class="runtime-task__title">{{ task.description || task.kind || taskId(task) }}</p>
            <p class="runtime-task__meta">
              <span>{{ statusLabel(task.status) }}</span>
              <span v-if="task.kind" class="runtime-task__tag">{{ task.kind }}</span>
              <span v-if="task.run_id" class="runtime-task__tag" :title="task.run_id">Run {{ shortId(task.run_id) }}</span>
              <span v-if="task.error" class="runtime-task__error" role="alert">{{ task.error }}</span>
              <span v-else-if="!task.cancel_available && task.status === 'running'" class="runtime-task__muted">
                {{ cancelReason(task) }}
              </span>
            </p>
          </div>
          <div class="runtime-task__actions">
            <Tooltip v-if="task.cancel_available">
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="taskState.selectedTaskIds.includes(taskId(task)) ? '取消选择任务' : '选择任务'"
                  @click="taskState.toggleTaskSelection(task)"
                >
                  <CheckSquare2 v-if="taskState.selectedTaskIds.includes(taskId(task))" data-icon="inline-start" />
                  <Square v-else data-icon="inline-start" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ taskState.selectedTaskIds.includes(taskId(task)) ? '取消选择' : '选择' }}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :disabled="!task.cancel_available || taskState.cancelling"
                    :aria-label="'取消后台任务'"
                    @click="taskState.cancelTask(task)"
                  >
                    <Ban data-icon="inline-start" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{{ task.cancel_available ? '取消任务' : cancelReason(task) }}</TooltipContent>
            </Tooltip>
          </div>
        </li>
      </ul>
    </TooltipProvider>

    <p v-if="taskState.error && taskState.tasks.length" class="runtime-error" role="alert">{{ taskState.error }}</p>
  </section>
</template>

<script setup>
import { Ban, CheckSquare2, ListTodo, LoaderCircle, RefreshCw, Square } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import EmptyState from '@/components/EmptyState.vue';
import { backgroundTaskCancelReason, backgroundTaskId } from '@/composables/useSessionBackgroundTasks.js';
import { cn } from '@/lib/utils';
import { statusLabel, statusToneColor } from '@/utils/participantVisual.js';

const props = defineProps({
  taskState: { type: Object, required: true },
  embedded: { type: Boolean, default: false },
});

const taskId = backgroundTaskId;
const cancelReason = backgroundTaskCancelReason;
const shortId = (value) => String(value || '').slice(0, 8);

function handleFilterChange(value) {
  if (value) props.taskState.setFilter(value);
}
</script>

<style scoped>
.runtime-section {
  display: flex;
  flex-direction: column;
}

.runtime-section__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 10px;
}

.runtime-section__icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  color: var(--color-text-muted);
}

.runtime-section__icon.is-live {
  color: var(--color-brand-accent);
}

.runtime-section__icon svg {
  width: 100%;
  height: 100%;
}

.runtime-section__titles {
  min-width: 0;
  flex: 1;
}

.runtime-section__title {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 650;
  line-height: 1.3;
}

.runtime-section__subtitle {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.runtime-section__status {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-brand-accent);
}

.status-dot--live {
  animation: task-dot-pulse 1.4s ease-in-out infinite;
}

.runtime-filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 16px 8px;
}

.runtime-task-filter {
  justify-content: flex-start;
}

.runtime-filter-count {
  min-width: 20px;
  justify-content: center;
  padding: 1px 5px;
}

.runtime-cancel-selected {
  color: var(--color-error);
}

.runtime-task-list {
  display: flex;
  flex-direction: column;
  padding: 0 8px 10px;
}

.runtime-task {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: var(--radius-lg);
  transition: background var(--transition-fast);
}

.runtime-task:hover {
  background: var(--color-hover-overlay);
}

.runtime-task.is-selected {
  background: var(--color-active-bg);
}

.runtime-task__dot {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: var(--dot-color, var(--color-text-muted));
}

.runtime-task__dot.is-live {
  animation: task-dot-pulse 1.4s ease-in-out infinite;
}

.runtime-task__main {
  min-width: 0;
}

.runtime-task__title {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 550;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-task__meta {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.runtime-task__tag {
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--color-hover-overlay);
}

.runtime-task__error {
  color: var(--color-error);
}

.runtime-task__muted {
  color: var(--color-text-muted);
}

.runtime-task__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.runtime-task:hover .runtime-task__actions,
.runtime-task.is-selected .runtime-task__actions,
.runtime-task__actions:focus-within {
  opacity: 1;
}

.runtime-error {
  padding: 0 16px 12px;
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

.runtime-empty {
  margin: 8px 16px 16px;
}

@keyframes task-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--color-accent-rgb), 0.35); }
  50% { box-shadow: 0 0 0 3px rgba(var(--color-accent-rgb), 0); }
}

@media (prefers-reduced-motion: reduce) {
  .status-dot--live,
  .runtime-task__dot.is-live {
    animation: none;
  }
}
</style>
