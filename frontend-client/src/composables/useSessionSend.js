import { nextTick, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { createAssistantMessage } from './useMessageExecution.js';
import { getSessionTaskStatus, startStream, stopStream } from '../api/session.js';
import { useSessionRunStore } from '../stores/session-run.js';

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

const createRequestId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const buildUserMetadata = (attachments, metadata = {}) => ({
  ...(attachments.length ? { attachments } : {}),
  ...metadata,
});

const createUserMessage = (content, attachments, metadata = {}) => ({
  role: 'user',
  content,
  attachments,
  metadata: buildUserMetadata(attachments, metadata),
});

const createAgentStreamMetadata = (requestId) => ({
  request_id: requestId,
  execution_kind: 'agent_stream',
});

const createFollowupMetadata = (requestId, activeRun, fallbackRunId = null) => ({
  request_id: requestId,
  execution_kind: 'session_followup',
  source: 'running_session',
  persistence_status: 'pending',
  ...(activeRun.runId || fallbackRunId ? { run_id: activeRun.runId || fallbackRunId } : {}),
});

function normalizeSessionSendDeps(deps) {
  const {
    state = {},
    composer = {},
    session = {},
    connection = {},
    attachments = {},
    messageStore = {},
    editing = {},
    runtime = {},
    ui = {},
  } = deps || {};

  return {
    ...deps,
    ...state,
    ...composer,
    ...session,
    ...connection,
    ...attachments,
    ...messageStore,
    ...editing,
    ...runtime,
    ...ui,
  };
}

/**
 * 发送、停止和 active run 初始化控制。
 */
export function useSessionSend(deps) {
  deps = normalizeSessionSendDeps(deps);
  const { currentSessionId, messages, isLoading } = storeToRefs(useSessionRunStore());
  const lastFailedSendContent = ref('');

  const handleStop = async () => {
    if (!currentSessionId.value) return;

    const ws = deps.getWS?.();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'abort', session_id: currentSessionId.value, payload: { scope: 'run' } }));
    } else {
      try {
        await stopStream(currentSessionId.value);
      } catch (error) {
        console.warn('停止请求发送失败:', error);
      }
    }
    deps.sessionTaskInfo.value = {
      ...(deps.sessionTaskInfo.value || {}),
      status: 'cancel_requested',
    };
    // 不在此处乐观结束 run / 显示"已停止"tag：等 WS 回传 run.end(interrupted) 确认打断成功后再显示
  };

  const handleSend = async (payload = null) => {
    const content = (payload?.content ?? deps.inputMessage.value).trim();
    const draftAttachments = Array.isArray(payload?.attachments)
      ? payload.attachments.slice()
      : deps.pendingAttachments.value.slice();
    const replaceFromIndex = Number.isInteger(payload?.replaceFromIndex) ? payload.replaceFromIndex : null;
    const clearEditing = payload?.clearEditing === true;
    let isRunningFollowup = Boolean(
      currentSessionId.value
      && deps.activeRun.active
      && replaceFromIndex == null
    );
    if ((!content && !draftAttachments.length) || (isLoading.value && !isRunningFollowup)) return;
    if (isRunningFollowup && draftAttachments.length) {
      deps.showToast('运行中补充暂不支持附件', 'warning');
      return;
    }

    const startsDraftSession = !currentSessionId.value && replaceFromIndex == null;
    const requestId = createRequestId();
    let userMetadata = isRunningFollowup
      ? createFollowupMetadata(requestId, deps.activeRun)
      : createAgentStreamMetadata(requestId);
    let sessionId = currentSessionId.value;
    let assistantMsgIndex = -1;
    let userMsgIndex = -1;
    let attachments = draftAttachments;
    let followupMsgIndex = -1;

    if (startsDraftSession) {
      userMsgIndex = messages.value.push(createUserMessage(content, draftAttachments, userMetadata)) - 1;
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
      deps.stickToBottom();

      assistantMsgIndex = messages.value.push(createAssistantMessage()) - 1;
      resetActiveRunForSend(deps.activeRun, assistantMsgIndex);
      deps.activeRun.phase = 'creating_session';
      isLoading.value = true;
      deps.contextUsage.value = { used: 0, max: 0 };
    }

    try {
      sessionId = await deps.ensureSession({ replaceRoute: startsDraftSession });
    } catch (error) {
      console.error('Error creating session:', error);
      if (startsDraftSession) {
        const currentMsg = messages.value[assistantMsgIndex];
        if (currentMsg) {
          currentMsg.content += `\n\n[System Error: ${error.message || '创建会话失败'}]`;
          currentMsg.finished = true;
        }
        resetActiveRunAfterSendError(deps.activeRun);
        isLoading.value = false;
      }
      deps.showToast('会话创建失败');
      return;
    }

    if (startsDraftSession && deps.activeRun.active) {
      deps.activeRun.phase = draftAttachments.length ? 'preparing_attachments' : 'starting_agent';
    }

    try {
      const result = await getSessionTaskStatus(sessionId);
      deps.sessionTaskInfo.value = result.data?.task_info || null;
      if (result.data?.observability) {
        deps.mergeExecutionObservability(result.data.observability);
      }
      if (result.data?.has_running_task && !isRunningFollowup) {
        if (sessionId && replaceFromIndex == null && !startsDraftSession) {
          isRunningFollowup = true;
          userMetadata = createFollowupMetadata(requestId, deps.activeRun, result.data?.task_info?.run_id || null);
        } else {
          deps.showToast('该会话正在执行任务，请等待完成或先停止', 'warning');
          if (startsDraftSession) {
            const currentMsg = messages.value[assistantMsgIndex];
            if (currentMsg) {
              currentMsg.content += '\n\n[System Error: 该会话正在执行任务，请等待完成或先停止]';
              currentMsg.finished = true;
            }
            resetActiveRunAfterSendError(deps.activeRun);
            isLoading.value = false;
          }
          return;
        }
      }
    } catch (error) {
      console.warn('发送前查询任务状态失败:', error.message);
    }

    try {
      attachments = isRunningFollowup
        ? []
        : await deps.materializeAttachmentsForSend(draftAttachments, sessionId);
    } catch (error) {
      if (startsDraftSession) {
        const currentMsg = messages.value[assistantMsgIndex];
        if (currentMsg) {
          currentMsg.content += `\n\n[System Error: ${error.message || '附件准备失败'}]`;
          currentMsg.finished = true;
        }
        resetActiveRunAfterSendError(deps.activeRun);
        isLoading.value = false;
      }
      deps.showToast(error.message || '附件准备失败');
      return;
    }

    if (startsDraftSession && deps.activeRun.active) {
      deps.activeRun.phase = 'starting_agent';
    }

    if (replaceFromIndex != null) {
      messages.value = messages.value.slice(0, replaceFromIndex);
      deps.cacheMessages(sessionId, messages.value);
      if (clearEditing) {
        deps.resetEditingState({ closeDrawer: false });
        deps.clearEditingAttachments();
      }
    }

    if (startsDraftSession) {
      const userMsg = messages.value[userMsgIndex];
      if (userMsg) {
        userMsg.attachments = attachments;
        userMsg.metadata = buildUserMetadata(attachments, userMetadata);
      }
      deps.cacheMessages(sessionId, messages.value);
    } else if (isRunningFollowup) {
      const followupMsg = createUserMessage(content, [], userMetadata);
      const insertIndex = deps.activeRun.assistantMsgIndex >= 0
        ? Math.min(deps.activeRun.assistantMsgIndex, messages.value.length)
        : messages.value.length;
      messages.value.splice(insertIndex, 0, followupMsg);
      followupMsgIndex = insertIndex;
      if (deps.activeRun.assistantMsgIndex >= insertIndex) {
        deps.activeRun.assistantMsgIndex += 1;
      }
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
      deps.cacheMessages(sessionId, messages.value);
      deps.stickToBottom();
    } else {
      messages.value.push(createUserMessage(content, attachments, userMetadata));
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
      deps.stickToBottom();
    }
    deps.updateRecentSession(sessionId, content, new Date().toISOString());

    if (!startsDraftSession && !isRunningFollowup) {
      assistantMsgIndex = messages.value.push(createAssistantMessage()) - 1;
      resetActiveRunForSend(deps.activeRun, assistantMsgIndex);
    }

    if (!isRunningFollowup) {
      deps.beginOptimisticExecutionState(sessionId);
    }
    if (!startsDraftSession && !isRunningFollowup) {
      isLoading.value = true;
      deps.contextUsage.value = { used: 0, max: 0 };
    }

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
        // 通过 WS 发送，ack 结果由 handleWSMessage 中的 ack(category=send) 处理
        ws.send(JSON.stringify({
          type: 'user_driven_change',
          session_id: sessionId,
          payload: {
            category: 'task_submit',
            task: body.task,
            attachments: body.attachments,
            ...(body.selected_llm ? { selected_llm: body.selected_llm } : {}),
            request_id: requestId,
          },
        }));
        if (!isRunningFollowup) {
          deps.scheduleCommandFallback(sessionId, assistantMsgIndex, 30000);
        }
        return;
      }

      const streamResp = await startStream(body, requestId);
      const result = streamResp.data || {};

      if (!result.started) {
        const errorMsg = result.error || '启动执行失败';
        if (result.kind === 'command') {
          deps.scheduleCommandFallback(sessionId, assistantMsgIndex);
          return;
        }
        throw new Error(errorMsg);
      }

      if (result.run_id) {
        deps.activeRun.runId = result.run_id;
      }
      if (!isRunningFollowup) {
        deps.activeRun.phase = 'llm_waiting_first_token';
      }

      if (result.kind === 'command') {
        deps.scheduleCommandFallback(sessionId, assistantMsgIndex, 60000);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      if (isRunningFollowup) {
        const followupMsg = messages.value[followupMsgIndex];
        if (followupMsg) {
          followupMsg.status = [
            ...(followupMsg.status || []),
            { type: 'error', content: error.message || '补充说明发送失败' },
          ];
          followupMsg.metadata = {
            ...(followupMsg.metadata || {}),
            persistence_status: 'failed',
          };
        }
      } else {
        const currentMsg = messages.value[assistantMsgIndex];
        if (currentMsg) {
          currentMsg.content += `\n\n[System Error: ${error.message || 'Request failed'}]`;
          currentMsg.finished = true;
        }
        deps.sessionTaskInfo.value = { ...(deps.sessionTaskInfo.value || {}), status: 'failed' };
        resetActiveRunAfterSendError(deps.activeRun);
        isLoading.value = false;
      }
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
