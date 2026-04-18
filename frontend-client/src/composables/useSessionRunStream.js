import { nextTick } from 'vue';

/**
 * 会话流式事件路由与 run 生命周期管理。
 *
 * 只负责消费 WS 事件、推进 activeRun/message 状态，
 * 不负责 socket 连接建立本身，也不改动视图模板结构。
 */
export function useSessionRunStream(deps) {
  const finalizeActiveRun = (sessionId) => {
    if (deps.activeRun.active) {
      const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
      if (currentMsg && !currentMsg.finished) {
        currentMsg.finished = true;
        if (currentMsg.content) {
          deps.updateRecentSession(sessionId, currentMsg.content, new Date().toISOString());
        }
        deps.checkSituationScreenTrigger(currentMsg.content);
      }
      deps.cacheMessages(sessionId, deps.messages.value);
      deps.activeRun.active = false;
    }
    deps.clearLlmRetryState();
    deps.isCompressing.value = false;
    deps.isLoading.value = false;
    deps.refreshSessionExecutionState(sessionId, { silent: true });
    deps.scrollToBottom();
  };

  const handleRunEvent = (event, currentMsg, sessionId) => {
    const eventData = event.data || {};
    const eventType = event.type;

    if (
      deps.llmRetryState.value
      && eventType !== 'agent.retry_scheduled'
      && (
        eventType === 'agent.intent_delta'
        || eventType === 'agent.intent_complete'
        || eventType === 'call.tool.start'
        || eventType === 'output.chunk'
        || eventType === 'output.final_answer'
        || eventType === 'agent.end'
        || eventType === 'agent.error'
        || eventType === 'done'
      )
    ) {
      deps.clearLlmRetryState();
    }

    if (event.seq) {
      if (deps.activeRun.lastSeenSeq > 0 && event.seq > deps.activeRun.lastSeenSeq + 1) {
        console.warn(`[WS] 事件序号 gap: expected=${deps.activeRun.lastSeenSeq + 1}, got=${event.seq}, missed=${event.seq - deps.activeRun.lastSeenSeq - 1}`);
      }
      deps.activeRun.lastSeenSeq = event.seq;
    }

    if (eventType === 'agent.retry_scheduled') {
      const waitMs = Number.isFinite(eventData.wait_ms) ? eventData.wait_ms : Math.round((eventData.wait_seconds || 0) * 1000);
      deps.setLlmRetryState({
        scope: eventData.scope || 'chat_completion_stream',
        nextAttempt: eventData.next_attempt || ((eventData.failed_attempt || 0) + 1),
        maxAttempts: eventData.max_attempts || 1,
        waitMs,
        error: eventData.error || '',
        provider: eventData.provider || '',
        model: eventData.model || '',
      });
      deps.sessionTaskInfo.value = { ...(deps.sessionTaskInfo.value || {}), status: 'running' };
    } else if (eventType === 'execution.step') {
      const projector = deps.ensureExecutionProjector(currentMsg);
      deps.applyStep(projector, eventData);
      deps.syncExecutionProjection(currentMsg);
    } else if (eventType === 'output.chunk') {
      if (deps.isMasterEvent(event)) {
        currentMsg.content += eventData.content;
        deps.scrollToBottom();
      } else {
        const subtask = deps.findSubtaskByCallId(currentMsg.subtasks, event.call_id);
        if (subtask) subtask.result_summary = (subtask.result_summary || '') + eventData.content;
      }
    } else if (eventType === 'output.final_answer') {
      if (deps.isMasterEvent(event)) {
        Object.assign(currentMsg, {
          ...(eventData.metadata ? { metadata: eventData.metadata } : {}),
          finished: true,
        });
        deps.updateRecentSession(sessionId, currentMsg.content, new Date().toISOString());
        deps.cacheMessages(sessionId, deps.messages.value);
      } else {
        const subtask = deps.findSubtaskByCallId(currentMsg.subtasks, event.call_id);
        if (subtask) {
          if (!subtask.result_summary) subtask.result_summary = eventData.content || '';
          if (subtask.status === 'running') subtask.status = 'success';
          subtask.expanded = false;
        }
      }
    } else if (eventType === 'output.message_saved') {
      const assistantMsgIndex = deps.activeRun.assistantMsgIndex;
      const target = eventData.role === 'user'
        ? deps.messages.value[assistantMsgIndex - 1]
        : currentMsg;
      if (target) {
        if (eventData.id != null) target.id = eventData.id;
        if (eventData.seq != null) target.seq = eventData.seq;
      }
      deps.cacheMessages(sessionId, deps.messages.value);
    } else if (eventType === 'agent.end' && deps.isMasterEvent(event)) {
      if (!currentMsg.finished) {
        currentMsg.finished = true;
        if (currentMsg.content) {
          deps.updateRecentSession(sessionId, currentMsg.content, new Date().toISOString());
        }
        deps.checkSituationScreenTrigger(currentMsg.content);
      }
    } else if (eventType === 'agent.error') {
      currentMsg.status.push({ type: 'error', content: eventData.error || eventData.content });
    } else if (eventType === 'context.usage') {
      if (eventData.compressing) deps.isCompressing.value = true;
      const agentName = event.agent_name;
      const ctx = { used: eventData.used_tokens, max: eventData.budget_tokens };
      if (deps.isRootEvent(event)) {
        deps.contextUsage.value = ctx;
      } else {
        const subtask = deps.findRunningSubtaskByAgentName(currentMsg.subtasks, agentName);
        if (subtask) subtask.ctx = ctx;
      }
    } else if (eventType === 'context.compression_start') {
      deps.isCompressing.value = true;
    } else if (eventType === 'context.compression_summary') {
      deps.isCompressing.value = false;
      const summaryContent = eventData.content || '';
      const alreadyExists = deps.messages.value.some(
        m => m.metadata?.compression && m.content === summaryContent
      );
      if (!alreadyExists) {
        const compressionMsg = {
          role: 'system',
          content: summaryContent,
          metadata: { compression: true },
        };
        deps.messages.value.splice(deps.activeRun.assistantMsgIndex, 0, compressionMsg);
        deps.activeRun.assistantMsgIndex++;
      }
    } else if (eventType === 'user.approval_required') {
      deps.enqueueApproval(event, eventData, sessionId);
    } else if (eventType === 'user.input_required') {
      deps.userInputDialogRef.value?.show(
        eventData,
        async (inputId, value) => {
          if (deps.getWS()?.readyState === WebSocket.OPEN) {
            deps.getWS().send(JSON.stringify({ type: 'user_input', input_id: inputId, value }));
          } else {
            try {
              const resp = await fetch(
                `/api/agent/sessions/${encodeURIComponent(sessionId)}/inputs/${encodeURIComponent(inputId)}/respond`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) }
              );
              if (!resp.ok) {
                const result = await resp.json().catch(() => ({}));
                throw new Error(result.message || `用户输入提交失败 (${resp.status})`);
              }
            } catch (e) {
              console.warn('用户输入提交失败:', e);
              deps.showToast(e.message || '用户输入提交失败', 'warning');
            }
          }
        },
        async () => { await deps.handleStop(); }
      );
    }

    deps.scrollToBottom();
  };

  const handleWSMessage = (event, sessionId) => {
    if (sessionId !== deps.currentSessionId.value) return;

    const eventType = event.type;

    if (eventType === 'heartbeat') return;

    if (eventType === 'reconnect_start') {
      deps.clearSessionResumeRecovery();
      deps.activeRun.isReplaying = true;
      if (!deps.isLoading.value) {
        deps.isLoading.value = true;
        const lastMsg = deps.messages.value[deps.messages.value.length - 1];
        if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.finished) {
          deps.messages.value.push(deps.createAssistantMessage());
        }
        deps.activeRun.active = true;
        deps.activeRun.assistantMsgIndex = deps.messages.value.length - 1;
        deps.activeRun.runId = event.run_id || null;
        deps.activeRun.lastSeenSeq = 0;
      }
      if (event.run_id) {
        deps.sessionTaskInfo.value = {
          ...(deps.sessionTaskInfo.value || {}),
          run_id: event.run_id,
          session_id: sessionId,
          status: 'running',
        };
      }
      return;
    }
    if (eventType === 'reconnect_end') {
      deps.activeRun.isReplaying = false;
      return;
    }

    if (eventType === 'send.ack') {
      deps.clearCommandFallback();
      const ackData = event;
      if (!ackData.started && ackData.kind !== 'command') {
        const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
        if (currentMsg) {
          currentMsg.content = `\n\n[System Error: ${ackData.error || '启动执行失败'}]`;
          currentMsg.finished = true;
        }
        deps.sessionTaskInfo.value = { ...(deps.sessionTaskInfo.value || {}), status: 'failed' };
        deps.activeRun.active = false;
        deps.isLoading.value = false;
        return;
      }
      if (ackData.kind === 'command' && !ackData.started) {
        deps.scheduleCommandFallback(sessionId, deps.activeRun.assistantMsgIndex);
        return;
      }
      deps.activeRun.runId = ackData.run_id || null;
      if (ackData.kind === 'command') {
        deps.scheduleCommandFallback(sessionId, deps.activeRun.assistantMsgIndex, 60000);
      }
      return;
    }

    if (eventType === 'send.error') {
      deps.clearCommandFallback();
      const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
      if (currentMsg) {
        currentMsg.content = `\n\n[System Error: ${event.error || 'Request failed'}]`;
        currentMsg.finished = true;
      }
      deps.sessionTaskInfo.value = { ...(deps.sessionTaskInfo.value || {}), status: 'failed' };
      deps.activeRun.active = false;
      deps.isLoading.value = false;
      deps.showToast('消息发送失败', 'warning');
      return;
    }

    if (eventType === 'approve.error') {
      if (event.approval_id) {
        deps.handleApprovalResolved(event.approval_id, sessionId);
      }
      deps.showToast(event.error || '审批提交失败', 'warning');
      return;
    }
    if (eventType === 'user.approval_granted' || eventType === 'user.approval_denied') {
      const approvalId = event.data?.approval_id || event.approval_id || '';
      deps.handleApprovalResolved(approvalId, sessionId);
      return;
    }

    if (eventType === 'user_input.error') {
      deps.showToast(event.error || '用户输入提交失败', 'warning');
      return;
    }
    if (deps.activeRun.isReplaying && (eventType === 'heartbeat' || eventType === 'done')) {
      return;
    }

    if (eventType === 'session.run_started') {
      const nextRunId = event.run_id || event.data?.run_id || null;
      const shouldStartNewMessage = !deps.activeRun.active || (deps.activeRun.runId && nextRunId && deps.activeRun.runId !== nextRunId);
      if (shouldStartNewMessage) {
        const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
        if (currentMsg && !currentMsg.finished) {
          currentMsg.finished = true;
        }

        const hasNotificationMsg = deps.messages.value.some(
          msg => msg.role === 'user' && msg.metadata?.source === 'system.bg_notification' && msg._bgRunId === nextRunId
        );
        if (!hasNotificationMsg) {
          deps.messages.value.push(deps.buildTaskNotificationMessage(sessionId, event));
        }

        deps.messages.value.push(deps.createAssistantMessage({ run_id: nextRunId }));
        deps.activeRun.active = true;
        deps.activeRun.assistantMsgIndex = deps.messages.value.length - 1;
        deps.activeRun.lastSeenSeq = 0;
        deps.activeRun.isReplaying = false;
      }
      deps.activeRun.runId = nextRunId;
      deps.isLoading.value = true;
      deps.sessionTaskInfo.value = {
        ...(deps.sessionTaskInfo.value || {}),
        run_id: nextRunId,
        session_id: sessionId,
        status: 'running',
      };
      deps.refreshSessionExecutionState(sessionId, { silent: true });
      nextTick(() => deps.scrollToBottom(true));
      return;
    }

    if (eventType === 'command.result') {
      const cmdData = event.data || event;
      if (cmdData.type === 'command.started') {
        deps.scheduleCommandFallback(sessionId, deps.activeRun.assistantMsgIndex, 120000);
        return;
      }
      deps.clearCommandFallback();
      let targetIndex = deps.messages.value.length - 1;
      let targetMsg = deps.messages.value[targetIndex];
      if (!targetMsg || targetMsg.role !== 'assistant' || targetMsg.finished) {
        deps.messages.value.push(deps.createAssistantMessage());
        targetIndex = deps.messages.value.length - 1;
        targetMsg = deps.messages.value[targetIndex];
      }
      targetMsg.content = cmdData.content || '';
      targetMsg.metadata = {
        ...targetMsg.metadata,
        type: 'command_result',
        command: cmdData.command || 'unknown',
        success: cmdData.success !== false,
        error: cmdData.error || null,
        data: cmdData.data || null,
      };
      targetMsg.finished = true;
      deps.isLoading.value = false;
      deps.deleteMessageCache(sessionId);
      deps.loadSessionMessages(sessionId, { silent: true });
      nextTick(() => deps.scrollToBottom(true));
      return;
    }

    if (eventType === 'session.updated') {
      if (!deps.isLoading.value) {
        deps.deleteMessageCache(sessionId);
        deps.loadSessionMessages(sessionId, { silent: true });
      }
      return;
    }

    if (eventType === 'run.end' || eventType === 'done') {
      deps.sessionTaskInfo.value = {
        ...(deps.sessionTaskInfo.value || {}),
        thread_alive: false,
        status: 'completed',
      };
      finalizeActiveRun(sessionId);
      return;
    }

    if (deps.activeRun.active) {
      const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
      if (currentMsg) {
        deps.mergeExecutionObservability(event);
        handleRunEvent(event, currentMsg, sessionId);
      }
    }
  };

  return {
    handleRunEvent,
    handleWSMessage,
    finalizeActiveRun,
  };
}
