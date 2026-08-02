import { computed } from 'vue';

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

  const getActiveRunPhaseText = () => {
    if (activeRun.phase === 'approval_waiting') return getInteractionWaitingText();
    if (activeRun.phase === 'model_streaming') return '模型输出中';
    if (activeRun.phase === 'model_waiting') return '等待模型响应';
    if (activeRun.phase === 'creating_session') return '创建会话中';
    if (activeRun.phase === 'preparing_attachments') return '准备附件中';
    if (activeRun.phase === 'starting_agent') return '启动 Agent 中';
    if (activeRun.phase === 'tool_running') {
      const count = Object.keys(activeRun.runningToolCalls || {}).length;
      return count > 1 ? `工具执行中 · ${count} 个` : '工具执行中';
    }
    if (activeRun.phase === 'retrying') return '重试中';
    return 'Agent 处理中';
  };

  const getAssistantRuntimeStatusText = (msg) => {
    if (!msg || msg.role !== 'assistant' || msg.finished) return '';
    if (!activeRun.active || messages.value[activeRun.assistantMsgIndex] !== msg) return '';
    if (llmRetryState.value) return '模型调用重试中';

    const runtimeState = sessionRuntime.value?.state;
    if (runtimeState === 'suspended') return getInteractionWaitingText(true);
    if (runtimeState === 'waiting_interaction') return getInteractionWaitingText();
    if (runtimeState === 'resuming') return '正在恢复执行';

    return isLoading.value ? getActiveRunPhaseText() : '';
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
      return getActiveRunPhaseText();
    }

    const lastStatus = sessionRuntime.value?.last_run?.status;
    if (lastStatus === 'interrupted') return '已中断';
    if (lastStatus === 'failed') return '失败';
    if (lastStatus === 'completed') return '已完成';
    return '空闲';
  });

  const showExecutionPill = computed(() => {
    return Boolean(currentSessionId.value && (sessionRuntime.value?.active_run
      || sessionRuntime.value?.maintenance
      || sessionRuntime.value?.last_run
      || isLoading.value));
  });

  return {
    contextUsagePct,
    contextUsageClass,
    getAssistantRuntimeStatusText,
    executionStatusText,
    showExecutionPill,
  };
}
