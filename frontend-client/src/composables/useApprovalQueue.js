import { ref } from 'vue';

function normalizeApprovalEventData(event, eventData) {
  const rawData = eventData && typeof eventData === 'object'
    ? eventData
    : (event?.data && typeof event.data === 'object' ? event.data : null);
  const data = rawData ? { ...rawData } : {};
  return {
    ...data,
    approval_id: data.approval_id || '',
    agent_name: event?.agent_name || data.agent_name || '智能体',
  };
}

/**
 * 审批队列、提交和工作栏内联用户输入管理。
 */
export function useApprovalQueue(deps) {
  const approvalQueue = ref([]);
  const approvalSubmittingId = ref('');
  const pendingUserInput = ref(null); // { data, submit, cancel }
  const ackTimers = new Map();

  const hideApprovalDialogs = () => {
    deps.approvalQueueHostRef.value?.hideApproval?.();
    deps.filePreviewDialogRef.value?.hide?.();
  };

  const removeApprovalFromQueue = (approvalId) => {
    if (!approvalId) return;
    approvalQueue.value = approvalQueue.value.filter(item => item?.approval_id !== approvalId);
  };

  const clearAckTimer = (approvalId) => {
    if (!ackTimers.has(approvalId)) return;
    clearTimeout(ackTimers.get(approvalId));
    ackTimers.delete(approvalId);
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
    const nextApproval = approvalQueue.value[0] || null;
    if (!nextApproval) {
      hideApprovalDialogs();
      return;
    }
    hideApprovalDialogs();
    showQueuedApproval(nextApproval, sessionId);
  };

  const handleApprovalResolved = (approvalId, sessionId) => {
    if (!approvalId) return;
    clearAckTimer(approvalId);
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
    approvalSubmittingId.value = approvalId;

    const ws = deps.getWS?.();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'approve', approval_id: approvalId, approved, message }));
      const ackTimer = setTimeout(async () => {
        ackTimers.delete(approvalId);
        if (approvalSubmittingId.value !== approvalId) return;
        console.warn(`[Approval] WS ack 超时 (${approvalId})，降级 HTTP 重试`);
        try {
          await sendApprovalHttp(approvalId, approved, message, sid);
          handleApprovalResolved(approvalId, sid);
        } catch (error) {
          removeApprovalFromQueue(approvalId);
          approvalSubmittingId.value = '';
          deps.showToast(error.message || '审批提交超时', 'warning');
          hideApprovalDialogs();
          showNextApproval(sid);
        }
      }, 5000);
      ackTimers.set(approvalId, ackTimer);
      return;
    }

    try {
      await sendApprovalHttp(approvalId, approved, message, sid);
      handleApprovalResolved(approvalId, sid);
    } catch (error) {
      removeApprovalFromQueue(approvalId);
      approvalSubmittingId.value = '';
      console.warn('审批响应失败:', error);
      deps.showToast(error.message || '审批提交失败', 'warning');
      hideApprovalDialogs();
      showNextApproval(sid);
    }
  };

  const sendApprovalHttp = async (approvalId, approved, message, sessionId) => {
    const resp = await fetch(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/respond`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, message }),
      }
    );
    if (!resp.ok) {
      const result = await resp.json().catch(() => ({}));
      throw new Error(result.message || `审批提交失败 (${resp.status})`);
    }
  };

  const handleWorkPanelUserInputSubmit = async ({ inputId, value } = {}) => {
    const pending = pendingUserInput.value;
    if (!pending?.submit) return;
    pendingUserInput.value = null;
    await pending.submit(inputId, value);
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

  const showUserInput = (eventData, submitFn, cancelFn) => {
    if (deps.showWorkPanel.value) {
      pendingUserInput.value = { data: eventData, submit: submitFn, cancel: cancelFn };
      return;
    }
    deps.approvalQueueHostRef.value?.showUserInput?.(eventData, submitFn, cancelFn);
  };

  const resetApprovalState = () => {
    approvalQueue.value = [];
    approvalSubmittingId.value = '';
    pendingUserInput.value = null;
    for (const timer of ackTimers.values()) {
      clearTimeout(timer);
    }
    ackTimers.clear();
    hideApprovalDialogs();
  };

  const enqueueApproval = (event, eventData, sessionId) => {
    const approval = normalizeApprovalEventData(event, eventData);
    if (!approval.approval_id) return;
    const exists = approvalQueue.value.some(item => item?.approval_id === approval.approval_id);
    if (!exists) {
      approvalQueue.value = [...approvalQueue.value, approval];
    }
    if (!deps.showWorkPanel.value) {
      showNextApproval(sessionId);
    }
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
  };
}
