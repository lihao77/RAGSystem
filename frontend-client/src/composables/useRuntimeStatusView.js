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
  sessionRuntime,
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

  const getInteractionWaitingText = (suspended = false) => {
    const interactions = sessionRuntime.value?.pending_interactions || [];
    const hasApproval = interactions.some(item => item.kind === 'approval');
    const hasUserInput = interactions.some(item => item.kind === 'user_input');
    const prefix = suspended ? '已挂起 · ' : '';
    if (hasApproval && hasUserInput) return `${prefix}等待用户交互`;
    if (hasUserInput) return `${prefix}等待用户输入`;
    if (hasApproval) return `${prefix}等待权限审批`;
    return suspended ? '已挂起' : '等待用户交互';
  };

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
    if (activeRun.phase === 'approval_waiting') return getInteractionWaitingText();
    if (activeRun.phase === 'tool_running') return '工具执行中';
    if (activeRun.phase === 'llm_streaming') return '模型输出中';
    if (activeRun.phase === 'llm_waiting_first_token') return '等待模型响应';
    return isLoading.value ? '正在运行' : '';
  };

  const executionStatusText = computed(() => {
    if (llmRetryState.value && isLoading.value) {
      return `重试中 · ${formatRetryCountdown(llmRetryState.value)}`;
    }

    const state = sessionRuntime.value?.state || 'idle';
    if (state === 'maintenance') return '会话维护中';
    if (state === 'suspended') return getInteractionWaitingText(true);
    if (state === 'waiting_interaction') return getInteractionWaitingText();
    if (state === 'resuming') return '正在恢复执行';

    if (state === 'running' || isLoading.value) {
      if (activeRun.phase === 'background_waiting') {
        const count = getBackgroundWaitingCount();
        return count > 0 ? `等待后台任务 · ${count} 个任务` : '等待后台任务';
      }
      if (activeRun.phase === 'approval_waiting') return getInteractionWaitingText();
      if (activeRun.phase === 'llm_streaming') return '模型输出中';
      if (activeRun.phase === 'llm_waiting_first_token') return '等待模型响应';
      if (activeRun.phase === 'creating_session') return '创建会话中';
      if (activeRun.phase === 'preparing_attachments') return '准备附件中';
      if (activeRun.phase === 'starting_agent') return '启动 Agent 中';
      if (activeRun.phase === 'tool_running') return '工具执行中';
      if (activeRun.phase === 'retrying') return '重试中';
      return '运行中';
    }

    const lastStatus = sessionRuntime.value?.last_run?.status;
    if (lastStatus === 'interrupted') return '已中断';
    if (lastStatus === 'failed') return '失败';
    if (lastStatus === 'completed') return '已完成';
    return '空闲';
  });

  const showExecutionPill = computed(() => {
    if (!currentSessionId.value) return false;
    return Boolean(sessionRuntime.value?.active_run
      || sessionRuntime.value?.maintenance
      || sessionRuntime.value?.last_run
      || isLoading.value);
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
