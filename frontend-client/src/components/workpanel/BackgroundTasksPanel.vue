<template>
  <section class="runtime-tab-panel">
    <div class="runtime-panel-header">
      <div class="min-w-0">
        <h3 class="runtime-panel-title">后台任务</h3>
        <p class="runtime-panel-subtitle">当前 Session 的持久后台执行</p>
      </div>
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
    </div>

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
        variant="outline"
        size="sm"
        :disabled="!taskState.selectedCancellableTasks.length || taskState.cancelling"
        @click="taskState.cancelSelected"
      >
        <LoaderCircle v-if="taskState.cancelling" data-icon="inline-start" class="animate-spin" />
        <Ban v-else data-icon="inline-start" />
        取消所选 {{ taskState.selectedCancellableTasks.length || '' }}
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

    <TooltipProvider v-else>
      <div class="runtime-task-list">
       <Card v-for="task in taskState.filteredTasks" :key="taskId(task)" class="shadow-none">
        <CardHeader class="gap-2 p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <CardTitle class="line-clamp-2">{{ task.description || task.kind || taskId(task) }}</CardTitle>
              <CardDescription class="truncate" :title="taskId(task)">{{ shortId(taskId(task)) }}</CardDescription>
            </div>
            <Badge :variant="taskStatusMeta(task.status).variant">{{ taskStatusMeta(task.status).label }}</Badge>
          </div>
        </CardHeader>
        <CardContent class="flex flex-col gap-2 px-3 pb-3">
          <div class="flex flex-wrap gap-2">
            <Badge v-if="task.kind" variant="outline">{{ task.kind }}</Badge>
            <Badge v-if="task.run_id" variant="secondary" :title="task.run_id">Run {{ shortId(task.run_id) }}</Badge>
          </div>
          <CardDescription v-if="!task.cancel_available && task.status === 'running'">
            {{ cancelReason(task) }}
          </CardDescription>
          <CardDescription v-if="task.error" role="alert">{{ task.error }}</CardDescription>
        </CardContent>
        <CardFooter class="justify-end gap-2 px-3 pb-3">
          <Tooltip>
              <TooltipTrigger as-child>
                <span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :active="taskState.selectedTaskIds.includes(taskId(task))"
                    :disabled="!task.cancel_available || taskState.cancelling"
                    :title="!task.cancel_available ? cancelReason(task) : '选择任务'"
                    :aria-label="taskState.selectedTaskIds.includes(taskId(task)) ? '取消选择任务' : '选择任务'"
                    @click="taskState.toggleTaskSelection(task)"
                  >
                    <CheckSquare2 v-if="taskState.selectedTaskIds.includes(taskId(task))" data-icon="inline-start" />
                    <Square v-else data-icon="inline-start" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent v-if="!task.cancel_available">{{ cancelReason(task) }}</TooltipContent>
          </Tooltip>
          <Tooltip>
              <TooltipTrigger as-child>
                <span>
                  <Button
                    variant="outline"
                    size="sm"
                    :disabled="!task.cancel_available || taskState.cancelling"
                    :title="!task.cancel_available ? cancelReason(task) : '取消后台任务'"
                    @click="taskState.cancelTask(task)"
                  >
                    <Ban data-icon="inline-start" />
                    取消
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent v-if="!task.cancel_available">{{ cancelReason(task) }}</TooltipContent>
          </Tooltip>
        </CardFooter>
      </Card>
      </div>
    </TooltipProvider>

    <p v-if="taskState.error && taskState.tasks.length" class="runtime-error" role="alert">{{ taskState.error }}</p>
  </section>
</template>

<script setup>
import { Ban, CheckSquare2, LoaderCircle, RefreshCw, Square } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import EmptyState from '@/components/EmptyState.vue';
import { backgroundTaskCancelReason, backgroundTaskId } from '@/composables/useSessionBackgroundTasks.js';
import { cn } from '@/lib/utils';

const props = defineProps({
  taskState: { type: Object, required: true },
});

const taskId = backgroundTaskId;
const cancelReason = backgroundTaskCancelReason;
const shortId = (value) => String(value || '').slice(0, 8);

function handleFilterChange(value) {
  if (value) props.taskState.setFilter(value);
}

function taskStatusMeta(status) {
  return ({
    running: { label: '运行中', variant: 'default' },
    completed: { label: '已完成', variant: 'success' },
    failed: { label: '失败', variant: 'destructive' },
    cancelled: { label: '已取消', variant: 'secondary' },
  }[status] || { label: status || '未知', variant: 'outline' });
}
</script>

<style scoped>
.runtime-tab-panel {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.runtime-panel-header,
.runtime-filter-bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
}

.runtime-filter-bar {
  flex-wrap: wrap;
  padding-block: 8px;
}

.runtime-task-filter {
  justify-content: flex-start;
}

.runtime-filter-count {
  min-width: 20px;
  justify-content: center;
  padding: 1px 5px;
}

.runtime-panel-title {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 650;
}

.runtime-panel-subtitle {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.runtime-task-list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding: 10px;
}

.runtime-error {
  flex: 0 0 auto;
  padding: 8px 14px;
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

.runtime-empty {
  margin: 14px;
}
</style>
