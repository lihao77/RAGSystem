<template>
  <section class="task-panel" aria-label="后台任务">
    <div class="task-panel__bar">
      <Transition name="task-bar-swap" mode="out-in">
        <!-- 进入多选时原地替换工具栏:列表不位移,操作就在选择发生的位置 -->
        <div v-if="taskState.selectedCancellableTasks.length" key="selection" class="task-panel__bar-state">
          <span class="task-panel__selected-count">已选 {{ taskState.selectedCancellableTasks.length }} 项</span>
          <div class="task-panel__tools">
            <button
              type="button"
              class="task-panel__batch-cancel"
              :disabled="taskState.cancelling"
              @click="taskState.cancelSelected"
            >
              <LoaderCircle v-if="taskState.cancelling" class="spin" />
              <Ban v-else />
              取消所选
            </button>
          </div>
        </div>
        <div v-else key="normal" class="task-panel__bar-state">
          <span class="panel-label">后台任务</span>
          <span class="task-panel__count" :class="{ 'is-live': taskState.runningCount }">
            {{ taskState.runningCount || taskState.tasks.length }}
          </span>
          <div class="task-panel__tools">
            <SegmentedControl
              :model-value="taskState.filter"
              :options="filterOptions"
              aria-label="后台任务筛选"
              class="task-panel__filter"
              @update:model-value="handleFilterChange"
            />
            <button
              type="button"
              class="icon-btn"
              :disabled="taskState.loading || taskState.cancelling"
              aria-label="刷新后台任务"
              title="刷新后台任务"
              @click="taskState.loadTasks()"
            >
              <RefreshCw :class="{ spin: taskState.loading }" />
            </button>
          </div>
        </div>
      </Transition>
    </div>

    <p v-if="taskState.error && !taskState.tasks.length" class="panel-note panel-note--error" role="alert">
      {{ taskState.error }}
    </p>

    <p v-else-if="!taskState.filteredTasks.length" class="panel-note">
      {{ taskState.loading ? '正在加载后台任务…' : taskState.filter === 'running' ? '暂无运行中的后台任务' : '暂无后台任务记录' }}
    </p>

    <ul v-else class="task-list">
      <li
        v-for="task in taskState.filteredTasks"
        :key="taskId(task)"
        class="task-row"
        :class="{ 'is-selected': taskState.selectedTaskIds.includes(taskId(task)) }"
      >
        <span
          class="task-row__dot"
          :class="{ 'is-live': task.status === 'running' }"
          :style="{ '--dot-color': statusToneColor(task.status) }"
          :title="statusLabel(task.status)"
        />
        <div class="task-row__main">
          <p class="task-row__title">{{ task.description || task.kind || taskId(task) }}</p>
          <p v-if="taskMeta(task).length" class="task-row__meta">
            <template v-for="(part, index) in taskMeta(task)" :key="index">
              <span v-if="part.error" class="task-row__error" role="alert">{{ part.text }}</span>
              <span v-else-if="part.tag" class="task-row__tag">{{ part.text }}</span>
              <span v-else>{{ part.text }}</span>
            </template>
          </p>
        </div>
        <div class="task-row__actions">
          <TooltipProvider v-if="task.cancel_available" :delay-duration="150">
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  type="button"
                  class="icon-btn"
                  :aria-label="taskState.selectedTaskIds.includes(taskId(task)) ? '取消选择任务' : '选择任务'"
                  @click="taskState.toggleTaskSelection(task)"
                >
                  <CheckSquare2 v-if="taskState.selectedTaskIds.includes(taskId(task))" />
                  <Square v-else />
                </button>
              </TooltipTrigger>
              <TooltipContent>{{ taskState.selectedTaskIds.includes(taskId(task)) ? '取消选择' : '选择' }}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider :delay-duration="150">
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="task-row__action-wrap">
                  <button
                    type="button"
                    class="icon-btn icon-btn--danger"
                    :disabled="!task.cancel_available || taskState.cancelling"
                    aria-label="取消后台任务"
                    @click="taskState.cancelTask(task)"
                  >
                    <Ban />
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{{ task.cancel_available ? '取消任务' : cancelReason(task) }}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </li>
    </ul>

    <p v-if="taskState.error && taskState.tasks.length" class="panel-note panel-note--error" role="alert">
      {{ taskState.error }}
    </p>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { Ban, CheckSquare2, LoaderCircle, RefreshCw, Square } from 'lucide-vue-next';
import SegmentedControl from '@/components/SegmentedControl.vue';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { backgroundTaskCancelReason, backgroundTaskId } from '@/composables/useSessionBackgroundTasks.js';
import { statusLabel, statusToneColor } from '@/utils/participantVisual.js';

// 异常/需注意状态才在 meta 行亮文字,其余只留色点(dot 的 title 已承载状态文字)。
const ATTENTION_STATUSES = new Set(['failed', 'interrupted', 'cancelled']);
const isAttentionStatus = (status) => ATTENTION_STATUSES.has(status);

const props = defineProps({
  taskState: { type: Object, required: true },
});

const taskId = backgroundTaskId;
const cancelReason = backgroundTaskCancelReason;
const shortId = (value) => String(value || '').slice(0, 8);

const filterOptions = computed(() => [
  { value: 'running', label: '运行中', badge: props.taskState.runningCount || null, ariaLabel: '只看运行中的后台任务' },
  { value: 'all', label: '全部', badge: props.taskState.tasks.length || null, ariaLabel: '查看全部后台任务' },
]);

// meta 行:状态文字(仅异常) / kind 标签 / Run 短 id / 错误或不可取消原因。
function taskMeta(task) {
  const parts = [];
  if (isAttentionStatus(task.status)) parts.push({ text: statusLabel(task.status), error: task.status === 'failed' || task.status === 'interrupted' });
  if (task.kind) parts.push({ text: task.kind, tag: true });
  if (task.run_id) parts.push({ text: `Run ${shortId(task.run_id)}`, tag: true, title: task.run_id });
  if (task.error) parts.push({ text: task.error, error: true });
  else if (!task.cancel_available && task.status === 'running') parts.push({ text: cancelReason(task) });
  return parts.filter((part) => part.text);
}

function handleFilterChange(value) {
  if (value) props.taskState.setFilter(value);
}
</script>

<style scoped>
/* 任务面板:眉题 + 计数丸 + 分段筛选,行项扁平、操作按钮 hover 才浮现 */
.task-panel {
  display: flex;
  flex-direction: column;
  padding: 12px 16px 14px;
}

/* 行高锁定为分段控件的实高(26px 项 + 2px×2 轨道 padding),
   两种状态在同一高度内垂直居中,切换不塌陷 */
.task-panel__bar {
  display: flex;
  height: 30px;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.panel-label {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 650;
  letter-spacing: 0.06em;
}

.task-panel__count {
  min-width: 18px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--color-hover-overlay-md);
  color: var(--color-text-secondary);
  font-size: var(--font-size-2xs);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  text-align: center;
}

.task-panel__count.is-live {
  background: color-mix(in srgb, var(--color-brand-accent) 14%, transparent);
  color: var(--color-brand-accent);
}

.task-panel__tools {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.task-panel__filter {
  flex: 0 0 auto;
}

.icon-btn {
  display: inline-flex;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.icon-btn:hover:not(:disabled) {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.icon-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

.icon-btn svg {
  width: 13px;
  height: 13px;
}

.icon-btn--danger:hover:not(:disabled) {
  background: var(--color-error-bg);
  color: var(--color-error);
}

/* 工具栏两种状态(浏览/多选)原地切换:同位等高,快速交叉淡入淡出,列表不动 */
.task-panel__bar-state {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  gap: 8px;
}

.task-bar-swap-enter-active,
.task-bar-swap-leave-active {
  transition: opacity var(--duration-fast) var(--ease-default);
}

.task-bar-swap-enter-from,
.task-bar-swap-leave-to {
  opacity: 0;
}

.task-panel__selected-count {
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.task-panel__batch-cancel {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 12px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: var(--font-size-xs);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

.task-panel__batch-cancel:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-error) 22%, transparent);
}

.task-panel__batch-cancel:disabled {
  cursor: default;
  opacity: 0.55;
}

.task-panel__batch-cancel svg {
  width: 12px;
  height: 12px;
}

.panel-note {
  padding: 4px 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.panel-note--error {
  color: var(--color-error);
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.task-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  margin: 0 -8px;
  border-radius: var(--radius-lg);
  transition: background var(--duration-fast) var(--ease-default);
}

.task-row:hover {
  background: var(--color-hover-overlay);
}

.task-row.is-selected {
  background: var(--color-active-bg);
}

.task-row__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: var(--dot-color, var(--color-text-muted));
}

.task-row__dot.is-live {
  animation: task-dot-pulse 1.6s var(--ease-default) infinite;
}

.task-row__main {
  min-width: 0;
  flex: 1;
}

.task-row__title {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-row__meta {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.task-row__tag {
  padding: 0 5px;
  border-radius: var(--radius-sm);
  background: var(--color-hover-overlay-md);
}

.task-row__error {
  color: var(--color-error);
}

.task-row__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.task-row:hover .task-row__actions,
.task-row.is-selected .task-row__actions,
.task-row__actions:focus-within {
  opacity: 1;
}

.task-row__action-wrap {
  display: inline-flex;
}

.spin {
  animation: task-spin 1s linear infinite;
}

@keyframes task-spin {
  to { transform: rotate(360deg); }
}

@keyframes task-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dot-color, transparent) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px transparent; }
}

@media (prefers-reduced-motion: reduce) {
  .spin,
  .task-row__dot.is-live {
    animation: none;
  }

  .task-bar-swap-enter-active,
  .task-bar-swap-leave-active {
    transition: none;
  }
}
</style>
