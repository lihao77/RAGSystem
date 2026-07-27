<template>
  <Card v-if="goal || error" class="mx-auto mb-2 w-full max-w-[920px] shadow-sm" aria-live="polite">
    <CardHeader class="flex-row items-start justify-between gap-3 p-4">
      <div class="flex min-w-0 items-start gap-3">
        <Target class="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div class="flex min-w-0 flex-col gap-1.5">
          <CardTitle>{{ goal ? '当前 Goal' : 'Goal' }}</CardTitle>
          <CardDescription class="line-clamp-2">
            {{ goal?.objective || '暂时无法读取当前 Goal' }}
          </CardDescription>
        </div>
      </div>
      <Badge v-if="goal" :variant="statusMeta.variant">{{ statusMeta.label }}</Badge>
    </CardHeader>

    <CardContent v-if="progressText || currentStep || error" class="flex flex-col gap-3 px-4 pb-4">
      <div v-if="progressText || currentStep" class="flex flex-wrap items-center gap-2">
        <Badge v-if="progressText" variant="outline">{{ progressText }}</Badge>
        <CardDescription v-if="currentStep" class="min-w-0 truncate">
          {{ currentStep.title || currentStep.description }}
        </CardDescription>
      </div>
      <CardDescription v-if="continuationReasonText" role="status">
        续跑状态：{{ continuationReasonText }}
      </CardDescription>
      <CardDescription v-if="error" role="alert">{{ error }}</CardDescription>
    </CardContent>

    <CardFooter class="flex-wrap justify-between gap-2 px-4 pb-4">
      <CardDescription v-if="goal">已自动续跑 {{ goal.continuation_count || 0 }} 次</CardDescription>
      <CardDescription v-else>可刷新后重试</CardDescription>
      <div class="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="loading || Boolean(pendingAction)"
          aria-label="刷新 Goal"
          title="刷新 Goal"
          @click="loadGoal()"
        >
          <RefreshCw data-icon="inline-start" :class="cn({ 'animate-spin': loading })" />
        </Button>
        <Button
          v-if="canPause"
          variant="outline"
          size="sm"
          :disabled="Boolean(pendingAction)"
          @click="pauseGoal"
        >
          <LoaderCircle v-if="pendingAction === 'pause'" data-icon="inline-start" class="animate-spin" />
          <Pause v-else data-icon="inline-start" />
          暂停 Goal
        </Button>
        <Button
          v-else-if="canStart"
          size="sm"
          :disabled="Boolean(pendingAction)"
          @click="startGoal"
        >
          <LoaderCircle v-if="pendingAction === 'start'" data-icon="inline-start" class="animate-spin" />
          <Play v-else data-icon="inline-start" />
          开启 Goal
        </Button>
      </div>
    </CardFooter>
  </Card>
</template>

<script setup>
import { computed, toRef, watch } from 'vue';
import { LoaderCircle, Pause, Play, RefreshCw, Target } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useSessionGoal } from '@/composables/useSessionGoal.js';

const props = defineProps({
  sessionId: { type: String, required: true },
  runActive: { type: Boolean, default: false },
});

const {
  goal,
  loading,
  pendingAction,
  error,
  canStart,
  canPause,
  loadGoal,
  startGoal,
  pauseGoal,
} = useSessionGoal(toRef(props, 'sessionId'));

const statusMeta = computed(() => ({
  active: { label: '进行中', variant: 'success' },
  paused: { label: '已暂停', variant: 'warning' },
  completed: { label: '已完成', variant: 'secondary' },
  blocked: { label: '已阻塞', variant: 'destructive' },
}[goal.value?.status] || { label: goal.value?.status || '未知', variant: 'outline' }));

const steps = computed(() => Array.isArray(goal.value?.steps) ? goal.value.steps : []);
const currentStep = computed(() => (
  steps.value.find((step) => step.status === 'in_progress')
  || steps.value.find((step) => step.status === 'pending')
  || null
));

const progressText = computed(() => {
  if (steps.value.length) {
    const completed = steps.value.filter((step) => step.status === 'completed').length;
    return `${completed} / ${steps.value.length} 阶段完成`;
  }

  const progress = goal.value?.progress ?? goal.value?.checkpoint;
  if (typeof progress === 'number') {
    const percentage = progress <= 1 ? progress * 100 : progress;
    return `进度 ${Math.max(0, Math.min(100, Math.round(percentage)))}%`;
  }
  if (typeof progress === 'string') return progress;
  if (progress && typeof progress === 'object') {
    return progress.summary || progress.description || progress.current_step || '';
  }
  return '';
});

const continuationReasonText = computed(() => ({
  manual_paused: '已手动暂停',
  run_still_running: '等待当前 Run 完成',
  background_tasks_running: '等待后台任务完成',
  goal_not_active: 'Goal 当前不可续跑',
  readiness_failed: 'Agent 或模型配置未就绪',
  max_continuations: '已达到自动续跑上限',
  no_progress_guard: '连续无进展，已触发保护',
  continuation_pending: '续跑请求正在处理中',
  continuation_start_failed: '续跑启动失败，将在下次空闲时重试',
}[goal.value?.continuation_reason] || ''));

watch(
  () => props.runActive,
  (active, wasActive) => {
    if (wasActive && !active) loadGoal({ silent: true });
  },
);
</script>
