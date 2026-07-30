import { ref } from 'vue';

function normalizeApprovalEventData(event, eventData) {
  const rawData = eventData && typeof eventData === 'object'
    ? eventData
    : (event?.payload && typeof event.payload === 'object' ? event.payload : null);
  const data = rawData ? { ...rawData } : {};
  // 新协议 interaction(required, approval)：payload{tool,input,risk_level,message} + 顶层{call_id,agent_id}
  // 映射到 UI 展示字段（approval_id/tool_name/agent_name/approval_reason/arguments）。
  return {
    ...data,
    approval_id: data.approval_id || data.interaction_id || event?.call_id || event?.interaction_id || '',
    tool_name: data.tool_name || data.tool || '',
    agent_name: event?.agent_id || event?.agent_name || data.agent_name || data.input?.agent_name || '智能体',
    approval_reason: data.approval_reason || data.message || data.prompt || '',
    arguments: data.arguments ?? data.input?.arguments ?? data.input ?? null,
    approval_type: data.approval_type ?? data.input?.approval_type ?? null,
  };
}

/**
 * 审批队列、提交和工作栏内联用户输入管理。
 */
export function useApprovalQueue(deps) {
  const approvalQueue = ref([]);
  const approvalSubmittingId = ref('');
  const pendingUserInput = ref(null); // { data, submit, cancel }

  const hideApprovalDialogs = () => {
    deps.approvalQueueHostRef.value?.hideApproval?.();
    deps.filePreviewDialogRef.value?.hide?.();
  };

  const openExecutionPanel = () => {
    deps.openExecutionPanel?.();
  };

  const removeApprovalFromQueue = (approvalId) => {
    if (!approvalId) return;
    approvalQueue.value = approvalQueue.value.filter(item => item?.approval_id !== approvalId);
  };

  const showQueuedApproval = (approval, sessionId) => {
    if (!approval?.approval_id || !sessionId) return;
    const dialogRef = approval?.approval_type === 'file_read_confirm'
      ? deps.filePreviewDialogRef.value
      : deps.approvalQueueHostRef.value;
    if (!dialogRef?.show) return;
    dialogRef.show(
      { ...approval, queue_count: approvalQueue.value.length || 1 },
      (aid, message) => submitApproval(aid, true, message, sessionId),
      (aid, message) => submitApproval(aid, false, message, sessionId)
    );
  };

  const showNextApproval = (sessionId = deps.currentSessionId.value) => {
    if (!sessionId || approvalSubmittingId.value) return;
    // WorkPanel 模式：审批框靠 approvalQueue prop 自动渲染（currentApproval = queue[0]），
    // resolve 后 queue[0] 自动切到下一个，不触发 ApprovalQueueHost 弹窗——避免窄屏弹窗覆盖工作栏。
    const nextApproval = approvalQueue.value[0] || null;
    if (!nextApproval) {
      hideApprovalDialogs();
      return;
    }
    if (deps.canRespondInteraction && !deps.canRespondInteraction()) {
      hideApprovalDialogs();
      return;
    }
    // File preview confirmations keep their dedicated dialog even while the unified runtime
    // center is open; ordinary approvals render inline in the execution tab.
    if (deps.showWorkPanel.value && nextApproval.approval_type !== 'file_read_confirm') return;
    hideApprovalDialogs();
    showQueuedApproval(nextApproval, sessionId);
  };

  const handleApprovalResolved = (approvalId, sessionId) => {
    if (!approvalId) return;
    const currentApprovalId = approvalQueue.value[0]?.approval_id || '';
    removeApprovalFromQueue(approvalId);
    if (approvalSubmittingId.value === approvalId) {
      approvalSubmittingId.value = '';
    }
    if (currentApprovalId === approvalId) {
      hideApprovalDialogs();
    }
    showNextApproval(sessionId);
  };

  const submitApproval = async (approvalId, approved, message, sessionId) => {
    if (!approvalId || approvalSubmittingId.value) return;
    const sid = sessionId || deps.currentSessionId.value;
    if (!sid) return;
    if (deps.canRespondInteraction && !deps.canRespondInteraction()) {
      deps.showToast('当前 Session runtime 不允许响应交互', 'warning');
      return;
    }
    approvalSubmittingId.value = approvalId;
    try {
      await deps.respondInteraction(approvalId, { kind: 'approval', approved, message });
    } catch (error) {
      approvalSubmittingId.value = '';
      console.warn('审批响应失败:', error);
      deps.showToast(error.message || '审批提交失败', 'warning');
      hideApprovalDialogs();
      showNextApproval(sid);
    }
  };

  const handleWorkPanelUserInputSubmit = async ({ inputId, value } = {}) => {
    const pending = pendingUserInput.value;
    if (!pending?.submit) return;
    if (deps.canRespondInteraction && !deps.canRespondInteraction()) {
      deps.showToast('当前 Session runtime 不允许响应交互', 'warning');
      return;
    }
    try {
      await pending.submit(inputId, value);
    } catch (_) {
      if (!pendingUserInput.value) {
        pendingUserInput.value = pending;
      }
    }
  };

  const handleWorkPanelUserInputCancel = async () => {
    const pending = pendingUserInput.value;
    if (!pending?.cancel) {
      pendingUserInput.value = null;
      return;
    }
    pendingUserInput.value = null;
    await pending.cancel();
  };

  const handleUserInputResolved = (inputId) => {
    const currentId = pendingUserInput.value?.data?.input_id
      || pendingUserInput.value?.data?.interaction_id;
    if (!inputId || currentId !== inputId) return;
    pendingUserInput.value = null;
    deps.approvalQueueHostRef.value?.hideUserInput?.();
  };

  const showUserInput = (eventData, submitFn, cancelFn) => {
    openExecutionPanel();
    if (deps.showWorkPanel.value) {
      pendingUserInput.value = { data: eventData, submit: submitFn, cancel: cancelFn };
      return;
    }
    if (!deps.canRespondInteraction || deps.canRespondInteraction()) {
      deps.approvalQueueHostRef.value?.showUserInput?.(eventData, submitFn, cancelFn);
    }
  };

  const resetApprovalState = () => {
    approvalQueue.value = [];
    approvalSubmittingId.value = '';
    pendingUserInput.value = null;
    hideApprovalDialogs();
  };

  const enqueueApproval = (event, eventData, sessionId) => {
    const approval = normalizeApprovalEventData(event, eventData);
    if (!approval.approval_id) return;
    const exists = approvalQueue.value.some(item => item?.approval_id === approval.approval_id);
    if (!exists) {
      approvalQueue.value = [...approvalQueue.value, approval];
    }
    openExecutionPanel();
    showNextApproval(sessionId);
  };

  return {
    approvalQueue,
    approvalSubmittingId,
    pendingUserInput,
    enqueueApproval,
    handleApprovalResolved,
    submitApproval,
    showNextApproval,
    showUserInput,
    resetApprovalState,
    handleWorkPanelUserInputSubmit,
    handleWorkPanelUserInputCancel,
    handleUserInputResolved,
  };
}
