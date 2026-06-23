/**
 * 旧 run_step（execution.step 结构）→ 新 Envelope 适配器。
 *
 * 历史回放：getMessageRunSteps API 返回旧 execution.step payload（kind/phase/call_id/
 * parent_call_id/agent_display_name/round...），core applyEnvelope 只认新 Envelope。
 * 本适配器把旧 step 流转成 Envelope 流，喂 core 重建执行树——与实时 WS 路径（已是 Envelope）
 * 汇聚到同一投影入口。
 *
 * 映射：
 *   kind=tool,phase=start → tool_call
 *   kind=tool,phase=end   → tool_result
 *   kind=subtask,start    → agent_started（child agent，带 lineage.parent_call_id 挂父）
 *   kind=subtask,end      → agent_ended
 *   kind=intent,complete  → stream_output(intent_complete)
 * 每个 agent call_id 首次出现时合成 agent_started（带 agent_display_name），保证 root/child
 * agent 的 display_name 不丢（run_step 表无 root agent_started 帧时由 intent/tool step 补）。
 */

function lineageOf(parentCallId) {
  return parentCallId ? { parent_call_id: parentCallId } : undefined;
}

export function legacyStepToEnvelope(steps) {
  if (!Array.isArray(steps)) return [];
  const envelopes = [];
  const startedAgents = new Set();

  const ensureAgentStarted = (callId, agentId, displayName, parentCallId) => {
    if (!callId || startedAgents.has(callId)) return;
    startedAgents.add(callId);
    envelopes.push({
      type: 'agent_started',
      session_id: '',
      agent_id: agentId || callId,
      call_id: callId,
      payload: {
        phase: 'start',
        ...(displayName ? { display_name: displayName } : {}),
        ...(parentCallId ? { lineage: { parent_call_id: parentCallId } } : {}),
      },
    });
  };

  for (const step of steps) {
    if (!step || !step.kind) continue;
    const agentId = step.agent_name || '';
    const displayName = step.agent_display_name || '';

    if (step.kind === 'tool') {
      // tool 挂在所属 agent（call_id = parent_call_id）下；确保该 agent 已 started。
      ensureAgentStarted(step.parent_call_id, agentId, displayName, null);
      if (step.phase === 'start') {
        envelopes.push({
          type: 'tool_call',
          session_id: '',
          call_id: step.call_id,
          agent_id: agentId,
          payload: {
            tool: step.tool_name || '',
            input: step.arguments,
            phase: 'start',
            lineage: lineageOf(step.parent_call_id),
          },
        });
      } else if (step.phase === 'end') {
        envelopes.push({
          type: 'tool_result',
          session_id: '',
          call_id: step.call_id,
          agent_id: agentId,
          payload: {
            tool: step.tool_name || '',
            phase: 'end',
            ok: step.status !== 'error' && step.success !== false,
            observation: step.observation || step.result_preview || '',
            summary: step.summary || '',
            lineage: lineageOf(step.parent_call_id),
          },
        });
      }
      continue;
    }

    if (step.kind === 'subtask') {
      // subtask = child agent；start 合成 agent_started，end 产 agent_ended。
      ensureAgentStarted(step.call_id, agentId, displayName, step.parent_call_id);
      if (step.phase === 'end') {
        envelopes.push({
          type: 'agent_ended',
          session_id: '',
          agent_id: agentId,
          call_id: step.call_id,
          payload: {
            phase: 'end',
            result: step.result_preview || step.description || '',
            success: step.status !== 'error',
            ...(displayName ? { display_name: displayName } : {}),
            lineage: lineageOf(step.parent_call_id),
          },
        });
      }
      continue;
    }

    if (step.kind === 'intent') {
      // intent 属于某 agent（call_id = agent call_id）；确保该 agent started 后产 intent_complete。
      ensureAgentStarted(step.call_id, agentId, displayName, step.parent_call_id);
      envelopes.push({
        type: 'stream_output',
        session_id: '',
        call_id: step.call_id,
        agent_id: agentId,
        payload: {
          phase: 'intent_complete',
          content: step.content || '',
          ...(step.round != null ? { round: step.round } : {}),
        },
      });
      continue;
    }
  }
  return envelopes;
}
