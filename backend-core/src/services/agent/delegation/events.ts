import type { Envelope } from "../../../contracts/events.js";

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
  /** child agent 中文展示名；agent_started payload.display_name 用此（前端据 displayName 显示而非英文 agent_id）。 */
  childDisplayName: string;
  description: string;
  childAgentId: string;
  mode: "create" | "resume";
}

export function buildAgentCallStart(input: AgentCallStartEventInput & { runId: string }): Envelope {
  // call.agent.start → agent_started：agent_id=子 agent，call_id=子 agent call_id，
  // lineage.parent_call_id=父 agent call_id（挂父）。task=委派描述。
  // participant_id 顶层盖章：本帧是子 run 的锚点事件（agent-unit 条目诞生），参与者
  // 线程路由必须不依赖 payload 兜底——与其余子 run 信封的盖章口径一致。
  return {
      type: "agent_started",
      session_id: input.sessionId,
      run_id: input.runId,
      agent_id: input.agentName,
      call_id: input.agentCallId,
      participant_id: input.childAgentId,
      // 顶层 timestamp（ISO）供前端执行树推子 agent 工作时长。
      timestamp: new Date().toISOString(),
      payload: {
        phase: "start",
        task: input.description,
        display_name: input.childDisplayName,
        ...(input.parentCallId ? { invocation_call_id: input.parentCallId } : {}),
        child_agent_id: input.childAgentId,
        lineage: input.rootParentCallId ? { parent_call_id: input.rootParentCallId } : undefined,
      },
  };
}
