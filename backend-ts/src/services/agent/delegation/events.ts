import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";

export interface AgentCallStartEventInput {
  sessionId: string;
  parentRunId: string | null;
  parentAgentName: string;
  parentCallId: string | null;
  agentCallId: string;
  agentName: string;
  description: string;
  childAgentId: string;
  mode: "create" | "resume";
}

export interface AgentCallEndEventInput {
  sessionId: string;
  parentRunId: string | null;
  parentAgentName: string;
  parentCallId: string | null;
  agentCallId: string;
  agentName: string;
  result: string;
  success: boolean;
  childAgentId: string;
  mode: "create" | "resume";
}

export function publishAgentCallStart(clientEvents: ClientEventPublisher | null, input: AgentCallStartEventInput): void {
  if (!clientEvents) {
    return;
  }
  const payload = {
    agent_name: input.agentName,
    description: input.description,
    agent_display_name: input.agentName,
    child_agent_id: input.childAgentId,
    mode: input.mode,
  };
  clientEvents.publish(
    input.sessionId,
    {
      type: "call.agent.start",
      session_id: input.sessionId,
      ...(input.parentRunId ? { run_id: input.parentRunId } : {}),
      agent_name: input.parentAgentName,
      call_id: input.agentCallId,
      ...(input.parentCallId ? { parent_call_id: input.parentCallId } : {}),
      data: payload,
    },
    {
      runId: input.parentRunId,
      aggregateType: input.parentRunId ? "run" : "session",
      aggregateId: input.parentRunId ?? input.sessionId,
    },
  );
}

export function publishAgentCallEnd(clientEvents: ClientEventPublisher | null, input: AgentCallEndEventInput): void {
  if (!clientEvents) {
    return;
  }
  const payload = {
    agent_name: input.agentName,
    result: input.result.slice(0, 500),
    success: input.success,
    agent_display_name: input.agentName,
    child_agent_id: input.childAgentId,
    mode: input.mode,
  };
  clientEvents.publish(
    input.sessionId,
    {
      type: "call.agent.end",
      session_id: input.sessionId,
      ...(input.parentRunId ? { run_id: input.parentRunId } : {}),
      agent_name: input.parentAgentName,
      call_id: input.agentCallId,
      ...(input.parentCallId ? { parent_call_id: input.parentCallId } : {}),
      data: payload,
    },
    {
      runId: input.parentRunId,
      aggregateType: input.parentRunId ? "run" : "session",
      aggregateId: input.parentRunId ?? input.sessionId,
    },
  );
}
