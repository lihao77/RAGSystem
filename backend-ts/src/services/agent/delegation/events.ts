import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";

export interface AgentCallStartEventInput {
  sessionId: string;
  parentRunId: string | null;
  parentAgentName: string;
  parentCallId: string | null;
  /** root agent 的 call_id；lineage.parent_call_id 用此把 child agent 挂到父 agent 下。
   *  parentCallId 是父 agent 的 tool call_id，挂不到 agent（execution-tree 无 tool→agent 边）。 */
  rootParentCallId: string | null;
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
  /** root agent 的 call_id；lineage.parent_call_id 用此把 child agent 挂到父 agent 下。
   *  parentCallId 是父 agent 的 tool call_id，挂不到 agent（execution-tree 无 tool→agent 边）。 */
  rootParentCallId: string | null;
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
  // call.agent.start → agent_started：agent_id=子 agent，call_id=子 agent call_id，
  // lineage.parent_call_id=父 agent call_id（挂父）。task=委派描述。
  clientEvents.publish(
    input.sessionId,
    {
      type: "agent_started",
      session_id: input.sessionId,
      ...(input.parentRunId ? { run_id: input.parentRunId } : {}),
      agent_id: input.agentName,
      call_id: input.agentCallId,
      payload: {
        phase: "start",
        task: input.description,
        lineage: input.rootParentCallId ? { parent_call_id: input.rootParentCallId } : undefined,
      },
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
  clientEvents.publish(
    input.sessionId,
    {
      type: "agent_ended",
      session_id: input.sessionId,
      ...(input.parentRunId ? { run_id: input.parentRunId } : {}),
      agent_id: input.agentName,
      call_id: input.agentCallId,
      payload: {
        phase: "end",
        result: input.result.slice(0, 500),
        success: input.success,
        lineage: input.rootParentCallId ? { parent_call_id: input.rootParentCallId } : undefined,
      },
    },
    {
      runId: input.parentRunId,
      aggregateType: input.parentRunId ? "run" : "session",
      aggregateId: input.parentRunId ?? input.sessionId,
    },
  );
}
