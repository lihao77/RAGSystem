import { ref } from 'vue'

/**
 * 审批队列管理 composable
 *
 * @param {object} opts
 * @param {import('vue').ComputedRef<boolean>} opts.showWorkPanel - 是否双栏模式（true 时不弹对话框）
 * @param {Function} opts.showDialogFn - 窄屏时弹出对话框的回调 (approval, sessionId) => void
 * @param {Function} opts.hideDialogFn - 隐藏对话框
 * @param {Function} opts.sendApprovalHttp - HTTP 发送审批 (approvalId, approved, message, sessionId) => Promise
 * @param {Function} opts.getCurrentSessionId - () => string
 */
export function useApprovalQueue({
  showWorkPanel,
  showDialogFn,
  hideDialogFn,
  sendApprovalHttp,
  getCurrentSessionId,
}) {
  const approvalQueue = ref([])
  const approvalSubmittingId = ref('')
  const _ackTimers = new Map()

  const removeFromQueue = (approvalId) => {
    approvalQueue.value = approvalQueue.value.filter(item => item?.approval_id !== approvalId)
  }

  const showNextApproval = (sessionId) => {
    const sid = sessionId || getCurrentSessionId?.()
    if (!sid || approvalSubmittingId.value) return
    const next = approvalQueue.value[0] || null
    if (!next) return
    hideDialogFn?.()
    // 双栏模式：工作栏内联处理，无需弹窗
    if (showWorkPanel?.value) return
    showDialogFn?.(next, sid)
  }

  const enqueueApproval = (event, eventData, sessionId) => {
    const approval = normalizeApprovalEventData(event, eventData)
    if (!approval.approval_id) return
    const exists = approvalQueue.value.some(item => item?.approval_id === approval.approval_id)
    if (!exists) {
      approvalQueue.value = [...approvalQueue.value, approval]
    }
    showNextApproval(sessionId)
  }

  const handleApprovalResolved = (approvalId, sessionId) => {
    if (!approvalId) return
    if (_ackTimers.has(approvalId)) {
      clearTimeout(_ackTimers.get(approvalId))
      _ackTimers.delete(approvalId)
    }
    const currentApprovalId = approvalQueue.value[0]?.approval_id || ''
    removeFromQueue(approvalId)
    if (currentApprovalId === approvalId) {
      showNextApproval(sessionId)
    }
  }

  const submitApproval = async (approvalId, approved, message, sessionId) => {
    if (!approvalId || approvalSubmittingId.value) return
    approvalSubmittingId.value = approvalId
    try {
      await sendApprovalHttp(approvalId, approved, message, sessionId)
      handleApprovalResolved(approvalId, sessionId)
    } catch (e) {
      console.error('[approval] HTTP failed:', e)
      hideDialogFn?.()
      showNextApproval(sessionId)
    } finally {
      approvalSubmittingId.value = ''
    }
  }

  const registerAckTimer = (approvalId, timer) => {
    _ackTimers.set(approvalId, timer)
  }

  const resetApprovalState = () => {
    approvalQueue.value = []
    approvalSubmittingId.value = ''
    for (const t of _ackTimers.values()) clearTimeout(t)
    _ackTimers.clear()
  }

  return {
    approvalQueue,
    approvalSubmittingId,
    enqueueApproval,
    handleApprovalResolved,
    submitApproval,
    registerAckTimer,
    resetApprovalState,
    showNextApproval,
  }
}

/**
 * 将 approval 事件数据规范化为统一格式
 */
function normalizeApprovalEventData(event, eventData) {
  if (eventData) return { ...eventData }
  if (event?.data) {
    try { return { ...JSON.parse(event.data) } } catch { /* */ }
  }
  return event || {}
}
