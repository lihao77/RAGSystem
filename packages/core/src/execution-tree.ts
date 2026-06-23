/**
 * 执行树投影：消费新 envelope，重建执行体（agent）的 ReAct 轮次 + 子 agent 嵌套树。
 *
 * 消费：
 *   - agent_started / agent_ended：执行体生命周期，按 lineage.parent_call_id 嵌套；
 *     无 parent_call_id 者为 root（orchestrator）。
 *   - stream_output(intent_delta / intent_complete)：某 agent 一轮的 intent 文本，
 *     payload.round 标识轮次（ReAct 推断依据）。
 *   - tool_call / tool_result：工具调用按 call_id 配对，挂到所属 agent 的当前轮。
 *
 * ReAct 轮次推断：工具的 round = 所属 agent 最近一次 intent 的 round（stream_output 携带）；
 * 无 intent 时归到 round 0。协议顶层刻意不带 round/order（业务值下沉），core 据 ReAct
 * 结构（intent→tools→observation→intent）复现轮次分组——这是方案 B 的投影智能所在。
 *
 * 乱序容错：子 agent 可能先于父 agent 到达，按 parent_call_id 入 pending 队列，
 * 父 agent_started 到达时挂载。工具的父 agent 由 lineage.parent_call_id 指向，
 * 父未到则隐式创建占位 agent，待 agent_started 补全 parent 后自动归位。
 */
import type { Envelope } from "./protocol.js";
import type {
  ExecutionAgent,
  ExecutionRound,
  ExecutionToolCall,
  ExecutionTree,
} from "./agent-sdk.js";

/** 无显式 call_id 时的隐式 root 标识（容错：tool 无父时挂到此处）。 */
const IMPLICIT_ROOT_CALL_ID = "__root__";

export interface ExecutionTreeState {
  agentsByCallId: Map<string, ExecutionAgent>;
  toolsByCallId: Map<string, ExecutionToolCall>;
  pendingAgentsByParent: Map<string, ExecutionAgent[]>;
  raw: Envelope[];
}

export function createExecutionTreeState(): ExecutionTreeState {
  return {
    agentsByCallId: new Map(),
    toolsByCallId: new Map(),
    pendingAgentsByParent: new Map(),
    raw: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ensureAgent(
  state: ExecutionTreeState,
  callId: string,
  init: { agentId?: string | undefined; task?: string | undefined; parentCallId?: string | undefined },
): ExecutionAgent {
  const existing = state.agentsByCallId.get(callId);
  if (existing) {
    // 隐式创建时 agentId 回退为 callId；agent_started 带真实 agent_id 时补正。
    if (init.agentId && existing.agentId === existing.callId) existing.agentId = init.agentId;
    if (init.task && !existing.task) existing.task = init.task;
    if (init.parentCallId && !existing.parentCallId) {
      existing.parentCallId = init.parentCallId;
      attachAgent(state, existing);
    }
    return existing;
  }
  const agent: ExecutionAgent = {
    agentId: init.agentId ?? callId,
    callId,
    status: "running",
    rounds: [],
    children: [],
  };
  if (init.task) agent.task = init.task;
  if (init.parentCallId) agent.parentCallId = init.parentCallId;
  state.agentsByCallId.set(callId, agent);
  attachAgent(state, agent);
  return agent;
}

function attachAgent(state: ExecutionTreeState, agent: ExecutionAgent): void {
  const parentCallId = agent.parentCallId;
  if (!parentCallId) {
    // root 候选：buildExecutionTree 时据 parent 缺失判定，这里不强设单 root。
    return;
  }
  const parent = state.agentsByCallId.get(parentCallId);
  if (parent) {
    if (!parent.children.some((c) => c.callId === agent.callId)) {
      parent.children.push(agent);
    }
    flushPendingAgents(state, agent);
  } else {
    const queue = state.pendingAgentsByParent.get(parentCallId) ?? [];
    if (!queue.some((a) => a.callId === agent.callId)) queue.push(agent);
    state.pendingAgentsByParent.set(parentCallId, queue);
  }
}

function flushPendingAgents(state: ExecutionTreeState, parent: ExecutionAgent): void {
  const queue = state.pendingAgentsByParent.get(parent.callId);
  if (!queue) return;
  for (const child of queue) {
    if (!parent.children.some((c) => c.callId === child.callId)) parent.children.push(child);
  }
  state.pendingAgentsByParent.delete(parent.callId);
}

function ensureRound(agent: ExecutionAgent, round: number): ExecutionRound {
  const existing = agent.rounds.find((r) => r.round === round);
  if (existing) return existing;
  const r: ExecutionRound = { round, intent: "", intentComplete: false, toolCalls: [] };
  agent.rounds.push(r);
  return r;
}

/** 最近一轮的 round 号（ReAct 顺序：最后一个 round 即当前轮）；无任何轮时归 0。 */
function latestRound(agent: ExecutionAgent): number {
  for (let i = agent.rounds.length - 1; i >= 0; i -= 1) {
    const r = agent.rounds[i];
    if (r) return r.round;
  }
  return 0;
}

/** stream_output 按 call_id 路由到所属 agent；无 call_id 时归隐式 root。 */
function routeStreamAgent(state: ExecutionTreeState, env: Envelope): ExecutionAgent {
  const callId = asString(env.call_id) ?? IMPLICIT_ROOT_CALL_ID;
  return ensureAgent(state, callId, { agentId: asString(env.agent_id) });
}

function applyIntentStream(state: ExecutionTreeState, env: Envelope, payload: Record<string, unknown>): void {
  const phase = asString(payload.phase);
  if (phase !== "intent_delta" && phase !== "intent_complete") return;
  const agent = routeStreamAgent(state, env);
  const round = asNumber(payload.round) ?? latestRound(agent);
  const r = ensureRound(agent, round);
  const content = asString(payload.content);
  if (content) {
    if (phase === "intent_delta" && !r.intentComplete) r.intent += content;
    else r.intent = content;
  }
  if (phase === "intent_complete") r.intentComplete = true;
}

function applyToolCall(state: ExecutionTreeState, env: Envelope, payload: Record<string, unknown>): void {
  const callId = asString(env.call_id);
  if (!callId) return;
  const tool: ExecutionToolCall = {
    callId,
    toolName: asString(payload.tool) ?? "",
    status: "running",
  };
  if (payload.input !== undefined) tool.arguments = payload.input;
  state.toolsByCallId.set(callId, tool);

  const lineage = asRecord(payload.lineage);
  const parentCallId = asString(lineage.parent_call_id) ?? IMPLICIT_ROOT_CALL_ID;
  const parent = ensureAgent(state, parentCallId, {});
  const r = ensureRound(parent, latestRound(parent));
  if (!r.toolCalls.some((t) => t.callId === callId)) r.toolCalls.push(tool);
}

function applyToolResult(state: ExecutionTreeState, env: Envelope, payload: Record<string, unknown>): void {
  const callId = asString(env.call_id);
  if (!callId) return;
  const tool = state.toolsByCallId.get(callId);
  if (!tool) return;
  tool.status = payload.ok === true ? "succeeded" : "failed";
  const observation = asString(payload.observation);
  if (observation) tool.observation = observation;
  const summary = asString(payload.summary);
  if (summary) tool.summary = summary;
  const elapsed = asNumber(payload.elapsed_ms);
  if (elapsed !== undefined) tool.elapsedMs = elapsed;
  const approval = asRecord(payload.approval);
  const approvalStatus = asString(approval.status);
  if (approvalStatus === "pending" || approvalStatus === "granted" || approvalStatus === "denied") {
    tool.approval = { status: approvalStatus };
  }
}

/** 将一条 envelope 投影进状态机。 */
export function applyEnvelope(state: ExecutionTreeState, env: Envelope): void {
  state.raw.push(env);
  const payload = asRecord(env.payload);
  switch (env.type) {
    case "agent_started": {
      const callId = asString(env.call_id);
      if (!callId) return;
      const lineage = asRecord(payload.lineage);
      ensureAgent(state, callId, {
        agentId: asString(env.agent_id),
        task: asString(payload.task),
        parentCallId: asString(lineage.parent_call_id),
      });
      return;
    }
    case "agent_ended": {
      const callId = asString(env.call_id);
      if (!callId) return;
      const agent = state.agentsByCallId.get(callId);
      if (!agent) return;
      agent.status = payload.success === false ? "failed" : "succeeded";
      const result = asString(payload.result);
      if (result) agent.result = result;
      return;
    }
    case "stream_output":
      applyIntentStream(state, env, payload);
      return;
    case "tool_call":
      applyToolCall(state, env, payload);
      return;
    case "tool_result":
      applyToolResult(state, env, payload);
      return;
    default:
      return;
  }
}

/** 顶层便利：从一串 envelope 构建完整执行树。 */
export function buildExecutionTree(envs: Iterable<Envelope>): ExecutionTree {
  const state = createExecutionTreeState();
  for (const env of envs) applyEnvelope(state, env);
  return { root: resolveRoot(state), steps: state.raw };
}

/** 从已增量投影的 state 取当前执行树（applyEnvelope 后调用，无需重建）。 */
export function getExecutionTree(state: ExecutionTreeState): ExecutionTree {
  return { root: resolveRoot(state), steps: state.raw };
}

/** 选 root：优先无 parent_call_id 的 agent；全都有 parent 时回退隐式 root。 */
function resolveRoot(state: ExecutionTreeState): ExecutionAgent | null {
  for (const agent of state.agentsByCallId.values()) {
    if (!agent.parentCallId) return agent;
  }
  return state.agentsByCallId.get(IMPLICIT_ROOT_CALL_ID) ?? null;
}
