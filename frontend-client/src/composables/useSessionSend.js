import { nextTick, ref } from 'vue';
import { createAssistantMessage } from './useMessageExecution';

const resetActiveRunForSend = (activeRun, assistantMsgIndex) => {
  activeRun.active = true;
  activeRun.assistantMsgIndex = assistantMsgIndex;
  activeRun.runId = null;
  activeRun.lastSeenSeq = 0;
  activeRun.isReplaying = false;
  activeRun.phase = 'llm_waiting_first_token';
  activeRun.runStartedAt = Date.now() / 1000;
  activeRun.firstTokenAt = null;
  activeRun.firstTokenLatencyMs = null;
  activeRun.latestLlmFirstTokenAt = null;
  activeRun.lastChunkAt = null;
  activeRun.waiting = null;
  activeRun.outputCharCount = 0;
};

const resetActiveRunAfterSendError = (activeRun) => {
  activeRun.active = false;
  activeRun.phase = 'idle';
  activeRun.waiting = null;
  activeRun.runStartedAt = null;
  activeRun.firstTokenAt = null;
  activeRun.firstTokenLatencyMs = null;
  activeRun.latestLlmFirstTokenAt = null;
  activeRun.lastChunkAt = null;
  activeRun.outputCharCount = 0;
};

const serializeAttachmentForSend = ({ file_id, original_name, stored_name, mime, size, kind }) => ({
  file_id,
  original_name,
  stored_name,
  mime,
  size,
  kind,
});

/**
 * 发送、停止和 active run 初始化控制。
 */
export function useSessionSend(deps) {
  const lastFailedSendContent = ref('');

  const handleStop = async () => {
    if (!deps.currentSessionId.value) return;

    const ws = deps.getWS?.();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    } else {
      try {
        await fetch('/api/agent/stream/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: deps.currentSessionId.value }),
        });
      } catch (error) {
        console.warn('停止请求发送失败:', error);
      }
    }
    deps.sessionTaskInfo.value = {
      ...(deps.sessionTaskInfo.value || {}),
      status: 'cancel_requested',
    };

    const lastMsg = deps.messages.value[deps.messages.value.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.finished) {
      lastMsg.stopped = true;
      lastMsg.finished = true;
    }

    deps.activeRun.active = false;
    deps.isLoading.value = false;
  };

  const handleSend = async (payload = null) => {
    const content = (payload?.content ?? deps.inputMessage.value).trim();
    const draftAttachments = Array.isArray(payload?.attachments)
      ? payload.attachments.slice()
      : deps.pendingAttachments.value.slice();
    const replaceFromIndex = Number.isInteger(payload?.replaceFromIndex) ? payload.replaceFromIndex : null;
    const clearEditing = payload?.clearEditing === true;
    if ((!content && !draftAttachments.length) || deps.isLoading.value) return;

    const sessionId = await deps.ensureSession();

    try {
      const statusResp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/task-status`);
      if (statusResp.ok) {
        const result = await statusResp.json();
        deps.sessionTaskInfo.value = result.data?.task_info || null;
        if (result.data?.observability) {
          deps.mergeExecutionObservability(result.data.observability);
        }
        if (result.data?.has_running_task) {
          deps.showToast('该会话正在执行任务，请等待完成或先停止', 'warning');
          return;
        }
      }
    } catch (_) {
      // 查询失败不阻塞发送
    }

    const attachments = await deps.materializeAttachmentsForSend(draftAttachments, sessionId);

    if (replaceFromIndex != null) {
      deps.messages.value = deps.messages.value.slice(0, replaceFromIndex);
      deps.cacheMessages(sessionId, deps.messages.value);
      if (clearEditing) {
        deps.resetEditingState({ closeDrawer: false });
        deps.clearEditingAttachments();
      }
    }

    deps.messages.value.push({
      role: 'user',
      content,
      attachments,
      metadata: attachments.length ? { attachments } : {},
    });
    deps.inputMessage.value = '';
    deps.clearComposerAttachments();
    deps.stickToBottom();
    deps.updateRecentSession(sessionId, content, new Date().toISOString());

    const assistantMsgIndex = deps.messages.value.push(createAssistantMessage()) - 1;
    resetActiveRunForSend(deps.activeRun, assistantMsgIndex);

    deps.beginOptimisticExecutionState(sessionId);
    deps.isLoading.value = true;
    deps.contextUsage.value = { used: 0, max: 0 };

    try {
      const body = {
        task: content,
        session_id: sessionId,
        use_v2: true,
        attachments: attachments.map(serializeAttachmentForSend),
      };
      const selectedLlm = deps.getCurrentSelectedLlm();
      if (selectedLlm) {
        body.selected_llm = selectedLlm;
      }

      const ws = deps.getWS?.();
      if (ws?.readyState === WebSocket.OPEN) {
        // 通过 WS 发送，ack 结果由 handleWSMessage 中的 send.ack / send.error 处理
        ws.send(JSON.stringify({ type: 'send', ...body }));
        deps.scheduleCommandFallback(sessionId, assistantMsgIndex, 30000);
        return;
      }

      const response = await fetch('/api/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = (await response.json()).data || {};

      if (!response.ok || !result.started) {
        const errorMsg = result.error || '启动执行失败';
        if (result.kind === 'command') {
          deps.scheduleCommandFallback(sessionId, assistantMsgIndex);
          return;
        }
        throw new Error(errorMsg);
      }

      deps.activeRun.runId = result.run_id;

      if (result.kind === 'command') {
        deps.scheduleCommandFallback(sessionId, assistantMsgIndex, 60000);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      const currentMsg = deps.messages.value[assistantMsgIndex];
      if (currentMsg) {
        currentMsg.content += `\n\n[System Error: ${error.message || 'Request failed'}]`;
        currentMsg.finished = true;
      }
      deps.sessionTaskInfo.value = { ...(deps.sessionTaskInfo.value || {}), status: 'failed' };
      resetActiveRunAfterSendError(deps.activeRun);
      deps.isLoading.value = false;
      deps.showToast('消息发送失败', async () => {
        if (lastFailedSendContent.value) {
          deps.inputMessage.value = lastFailedSendContent.value;
          await nextTick();
          handleSend();
        }
      });
    }
  };

  return {
    handleSend,
    handleStop,
  };
}
