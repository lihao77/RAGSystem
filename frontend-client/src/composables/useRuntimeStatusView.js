import { computed } from 'vue';

const formatDurationMs = (ms) => {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;

  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;

  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes}m ${String(restSeconds).padStart(2, '0')}s`;
};

export function useRuntimeStatusView({
  currentSessionId,
  messages,
  isLoading,
  activeRun,
  llmRetryState,
  formatRetryCountdown,
  sessionTaskInfo,
  sessionExecutionObservability,
  contextUsage,
}) {
  const contextUsagePct = computed(() => {
    if (!contextUsage.value?.max) return 0;
    return Math.min(100, Math.round((contextUsage.value.used / contextUsage.value.max) * 100));
  });

  const contextUsageClass = computed(() => {
    const pct = contextUsagePct.value;
    if (pct >= 90) return 'danger';
    if (pct >= 70) return 'warning';
    return '';
  });

  const getBackgroundWaitingCount = () => (
    activeRun.waiting?.pendingTaskCount
    || activeRun.waiting?.pendingTaskIds?.length
    || activeRun.waiting?.backgroundTaskIds?.length
    || 0
  );

  const getAssistantRuntimeStatusText = (msg) => {
    if (!msg || msg.role !== 'assistant' || msg.finished) return '';
    if (!activeRun.active || messages.value[activeRun.assistantMsgIndex] !== msg) return '';
    if (llmRetryState.value) return '模型调用重试中';

    if (activeRun.phase === 'background_waiting') {
      const count = getBackgroundWaitingCount();
      return count > 0 ? `等待后台任务完成 · ${count} 个任务` : '等待后台任务完成';
    }
    if (activeRun.phase === 'creating_session') return '正在创建会话';
    if (activeRun.phase === 'preparing_attachments') return '正在准备附件';
    if (activeRun.phase === 'starting_agent') return '正在启动 Agent';
    if (activeRun.phase === 'approval_waiting') return '等待权限审批';
    if (activeRun.phase === 'tool_running') return '工具执行中';
    if (activeRun.phase === 'llm_streaming') return '模型输出中';
    if (activeRun.phase === 'llm_waiting_first_token') return '等待模型响应';
    return isLoading.value ? '正在运行' : '';
  };

  const executionStatusText = computed(() => {
    if (llmRetryState.value && isLoading.value) {
      return `重试中 · ${formatRetryCountdown(llmRetryState.value)}`;
    }

    const status = sessionTaskInfo.value?.status;
    if (status === 'cancel_requested') return '停止中';

    if (isLoading.value) {
      if (activeRun.phase === 'background_waiting') {
        const count = getBackgroundWaitingCount();
        return count > 0 ? `等待后台任务 · ${count} 个任务` : '等待后台任务';
      }
      if (activeRun.phase === 'approval_waiting') return '等待权限审批';
      if (activeRun.phase === 'llm_streaming') return '模型输出中';
      if (activeRun.phase === 'llm_waiting_first_token') return '等待模型响应';
      if (activeRun.phase === 'creating_session') return '创建会话中';
      if (activeRun.phase === 'preparing_attachments') return '准备附件中';
      if (activeRun.phase === 'starting_agent') return '启动 Agent 中';
      if (activeRun.phase === 'tool_running') return '工具执行中';
      if (activeRun.phase === 'retrying') return '重试中';
      return '运行中';
    }

    if (status === 'running') return '运行中';
    if (status === 'interrupted') return '已中断';
    if (status === 'failed') return '失败';
    if (status === 'completed') return '已完成';
    return '空闲';
  });

  const showExecutionPill = computed(() => {
    if (!currentSessionId.value) return false;
    if (isLoading.value) return true;
    if (sessionExecutionObservability.value?.task_id || sessionExecutionObservability.value?.run_id) return true;

    const status = sessionTaskInfo.value?.status;
    return status === 'running'
      || status === 'cancel_requested'
      || status === 'interrupted'
      || status === 'failed'
      || status === 'completed';
  });

  return {
    contextUsagePct,
    contextUsageClass,
    formatDurationMs,
    getAssistantRuntimeStatusText,
    executionStatusText,
    showExecutionPill,
  };
}
