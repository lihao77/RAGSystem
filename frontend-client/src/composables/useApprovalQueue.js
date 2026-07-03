import { ref } from 'vue';
import { respondInteraction } from '../api/session.js';

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
    // WorkPanel 模式：审批框靠 approvalQueue prop 自动渲染（currentApproval = queue[0]），
    // resolve 后 queue[0] 自动切到下一个，不触发 ApprovalQueueHost 弹窗——避免窄屏弹窗覆盖工作栏。
    if (deps.showWorkPanel.value) return;
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
      ws.send(JSON.stringify({ type: 'interaction', session_id: sid, call_id: approvalId, payload: { kind: 'approval', phase: 'responded', approved, message } }));
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
    await respondInteraction(sessionId, approvalId, { kind: 'approval', approved, message });
  };

  const handleWorkPanelUserInputSubmit = async ({ inputId, value } = {}) => {
    const pending = pendingUserInput.value;
    if (!pending?.submit) return;
    try {
      await pending.submit(inputId, value);
      if (pendingUserInput.value === pending) {
        pendingUserInput.value = null;
      }
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
