/** Mutations share the receipt identity; transport failures are reconciled through durable reads. */
export function createSessionFollowupActions({ sdk, store, recovery, showToast }) {
  const mutate = async (item) => {
    const { session_id: sessionId, request_id: requestId } = item;
    if (store.currentSessionId !== sessionId || !store.beginFollowupMutation(sessionId, requestId, false)) return false;
    let succeeded = false;
    try {
      const response = await sdk.cancelQueuedMessageRequest(sessionId, requestId, item.content);
      const receipt = response?.data?.item;
      if (!receipt) throw new Error('无法确认操作结果');
      if (receipt.status !== 'cancelled') throw new Error('消息状态未确认已取消');
      store.removePendingFollowup(sessionId, requestId);
      succeeded = true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '操作失败，正在同步消息状态', 'warning');
    } finally {
      store.finishFollowupMutation(sessionId, requestId);
      await recovery.refresh();
    }
    return succeeded;
  };
  return { takeBack: item => mutate(item), cancel: item => mutate(item) };
}
