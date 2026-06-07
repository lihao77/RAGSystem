import type { InMemoryEventBus } from "../../runtime/event-bus.js";

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

export function publishAgentCallStart(events: InMemoryEventBus | null, input: AgentCallStartEventInput): void {
  if (!events) {
    return;
  }
  const payload = {
    agent_name: input.agentName,
    description: input.description,
    agent_display_name: input.agentName,
    child_agent_id: input.childAgentId,
    mode: input.mode,
  };
  events.publish(input.sessionId, {
    type: "call.agent.start",
    session_id: input.sessionId,
    ...(input.parentRunId ? { run_id: input.parentRunId } : {}),
    agent_name: input.parentAgentName,
    call_id: input.agentCallId,
    ...(input.parentCallId ? { parent_call_id: input.parentCallId } : {}),
    ...mirrorEventData(payload),
  });
}

export function publishAgentCallEnd(events: InMemoryEventBus | null, input: AgentCallEndEventInput): void {
  if (!events) {
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
  events.publish(input.sessionId, {
    type: "call.agent.end",
    session_id: input.sessionId,
    ...(input.parentRunId ? { run_id: input.parentRunId } : {}),
    agent_name: input.parentAgentName,
    call_id: input.agentCallId,
    ...(input.parentCallId ? { parent_call_id: input.parentCallId } : {}),
    ...mirrorEventData(payload),
  });
}

function mirrorEventData<T extends Record<string, unknown>>(data: T): { data: T; content: T } {
  return {
    data,
    content: data,
  };
}
