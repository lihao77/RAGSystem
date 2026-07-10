import type { Envelope } from "@ragsystem/agent-protocol";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lineage(parentCallId: string | undefined): { parent_call_id: string } | undefined {
  return parentCallId ? { parent_call_id: parentCallId } : undefined;
}

/** Persisted execution.step payloads -> protocol envelopes for history replay. */
export function executionStepsToEnvelopes(
  steps: Record<string, unknown>[],
  sessionId: string,
): Envelope[] {
  const envelopes: Envelope[] = [];
  const startedAgents = new Set<string>();

  const ensureAgentStarted = (input: {
    callId: string | undefined;
    agentId: string | undefined;
    displayName: string | undefined;
    parentCallId?: string | undefined;
    invocationCallId?: string | undefined;
  }): void => {
    if (!input.callId || startedAgents.has(input.callId)) return;
    startedAgents.add(input.callId);
    envelopes.push({
      type: "agent_started",
      session_id: sessionId,
      agent_id: input.agentId ?? input.callId,
      call_id: input.callId,
      payload: {
        phase: "start",
        ...(input.displayName ? { display_name: input.displayName } : {}),
        ...(input.invocationCallId ? { invocation_call_id: input.invocationCallId } : {}),
        ...(input.parentCallId ? { lineage: lineage(input.parentCallId) } : {}),
      },
    });
  };

  for (const value of steps) {
    const step = asRecord(value);
    const kind = asString(step.kind);
    if (!kind) continue;

    const phase = asString(step.phase);
    const callId = asString(step.call_id);
    const parentCallId = asString(step.parent_call_id);
    const agentId = asString(step.agent_name);
    const displayName = asString(step.agent_display_name);
    const round = asNumber(step.round);

    if (kind === "run") {
      ensureAgentStarted({ callId, agentId, displayName, parentCallId });
      if (phase === "end" && callId) {
        envelopes.push({
          type: "agent_ended",
          session_id: sessionId,
          agent_id: agentId ?? callId,
          call_id: callId,
          payload: {
            phase: "end",
            result: asString(step.result_preview) ?? "",
            success: step.status === "completed" || step.status === "success",
            ...(displayName ? { display_name: displayName } : {}),
            ...(parentCallId ? { lineage: lineage(parentCallId) } : {}),
          },
        });
      }
      continue;
    }

    if (kind === "final") {
      ensureAgentStarted({ callId, agentId, displayName, parentCallId });
      envelopes.push({
        type: "stream_output",
        session_id: sessionId,
        ...(callId ? { call_id: callId } : {}),
        ...(agentId ? { agent_id: agentId } : {}),
        payload: {
          phase: "final",
          content: asString(step.result_preview) ?? asString(step.result) ?? "",
        },
      });
      continue;
    }

    if (kind === "tool") {
      ensureAgentStarted({ callId: parentCallId, agentId, displayName });
      if (!callId) continue;
      if (phase === "start") {
        envelopes.push({
          type: "tool_call",
          session_id: sessionId,
          call_id: callId,
          ...(agentId ? { agent_id: agentId } : {}),
          payload: {
            tool: asString(step.tool_name) ?? "",
            input: step.arguments,
            phase: "start",
            ...(round !== undefined ? { round } : {}),
            ...(parentCallId ? { lineage: lineage(parentCallId) } : {}),
          },
        });
      } else if (phase === "end") {
        const elapsedSeconds = asNumber(step.elapsed_time);
        envelopes.push({
          type: "tool_result",
          session_id: sessionId,
          call_id: callId,
          ...(agentId ? { agent_id: agentId } : {}),
          payload: {
            tool: asString(step.tool_name) ?? "",
            phase: "end",
            ok: step.status !== "error" && step.success !== false,
            observation: asString(step.observation) ?? asString(step.result_preview) ?? "",
            summary: asString(step.summary) ?? "",
            ...(elapsedSeconds !== undefined ? { elapsed_ms: elapsedSeconds * 1000 } : {}),
            ...(parentCallId ? { lineage: lineage(parentCallId) } : {}),
          },
        });
      }
      continue;
    }

    if (kind === "subtask") {
      ensureAgentStarted({ callId: parentCallId, agentId: undefined, displayName: undefined });
      ensureAgentStarted({
        callId,
        agentId,
        displayName,
        parentCallId,
        invocationCallId: callId,
      });
      if (phase === "end" && callId) {
        envelopes.push({
          type: "agent_ended",
          session_id: sessionId,
          agent_id: agentId ?? callId,
          call_id: callId,
          payload: {
            phase: "end",
            result: asString(step.result_preview) ?? asString(step.description) ?? "",
            success: step.status !== "error",
            ...(displayName ? { display_name: displayName } : {}),
            invocation_call_id: callId,
            ...(parentCallId ? { lineage: lineage(parentCallId) } : {}),
          },
        });
      }
      continue;
    }

    if (kind === "intent") {
      ensureAgentStarted({ callId, agentId, displayName, parentCallId });
      if (!callId) continue;
      envelopes.push({
        type: "stream_output",
        session_id: sessionId,
        call_id: callId,
        ...(agentId ? { agent_id: agentId } : {}),
        payload: {
          phase: "intent_complete",
          content: asString(step.content) ?? "",
          ...(round !== undefined ? { round } : {}),
        },
      });
    }
  }

  return envelopes;
}
