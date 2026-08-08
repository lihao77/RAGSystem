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
 * 无 intent 时归到 round 0。协议顶层刻意不带 round/order（业务值下沉），本包据 ReAct
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
} from "./agent-client.js";

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
  init: {
    agentId?: string | undefined;
    task?: string | undefined;
    parentCallId?: string | undefined;
    invocationCallId?: string | undefined;
    displayName?: string | undefined;
  },
): ExecutionAgent {
  const existing = state.agentsByCallId.get(callId);
  if (existing) {
    // 隐式创建时 agentId 回退为 callId；agent_started 带真实 agent_id 时补正。
    if (init.agentId && existing.agentId === existing.callId) existing.agentId = init.agentId;
    if (init.displayName && !existing.displayName) existing.displayName = init.displayName;
    if (init.invocationCallId && !existing.invocationCallId) existing.invocationCallId = init.invocationCallId;
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
  if (init.displayName) agent.displayName = init.displayName;
  if (init.invocationCallId) agent.invocationCallId = init.invocationCallId;
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
  const lineage = asRecord(env.payload).lineage;
  const parentCallId = asString(asRecord(lineage).parent_call_id);
  if (parentCallId) ensureAgent(state, parentCallId, {});
  return ensureAgent(state, callId, {
    agentId: asString(env.agent_id),
    ...(parentCallId ? { parentCallId } : {}),
  });
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

/** stream_output(delta/final)：agent 输出内容（非 intent 思考），累加到 agent.output（delta 累加 / final 覆盖）。 */
function applyOutputStream(state: ExecutionTreeState, env: Envelope, payload: Record<string, unknown>): void {
  const phase = asString(payload.phase);
  if (phase !== "delta" && phase !== "part_added" && phase !== "final") return;
  const agent = routeStreamAgent(state, env);
  if (phase === "part_added") {
    const part = asAssistantContentPart(payload.part);
    const partIndex = asNumber(payload.part_index);
    if (!part || partIndex === undefined || !Number.isInteger(partIndex) || partIndex < 0) return;
    if (!agent.outputParts) {
      agent.outputParts = [];
      if (partIndex > 0 && agent.output) agent.outputParts[0] = { type: "text", text: agent.output };
    }
    agent.outputParts[partIndex] = part;
    return;
  }
  const content = asString(payload.content);
  if (phase === "final") {
    if (content !== undefined) agent.output = content;
    if (Array.isArray(payload.content_parts)) {
      agent.outputParts = payload.content_parts.flatMap((part) => {
        const parsed = asAssistantContentPart(part);
        return parsed ? [parsed] : [];
      });
    }
    return;
  }
  if (!content) return;
  agent.output = (agent.output ?? "") + content;
  const partIndex = asNumber(payload.part_index);
  if (agent.outputParts && partIndex !== undefined && Number.isInteger(partIndex) && partIndex >= 0) {
    const existing = agent.outputParts[partIndex];
    agent.outputParts[partIndex] = existing?.type === "text"
      ? { type: "text", text: existing.text + content }
      : { type: "text", text: content };
  }
}

function asAssistantContentPart(value: unknown): import("./protocol.js").AssistantContentPart | null {
  const part = asRecord(value);
  if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
  if (part.type !== "file_ref") return null;
  const filePath = asString(part.file_path);
  const presentation = asString(part.presentation);
  if (!filePath || (presentation !== "inline" && presentation !== "attachment" && presentation !== "preview")) return null;
  const caption = asString(part.caption);
  return {
    type: "file_ref",
    file_path: filePath,
    presentation,
    ...(caption ? { caption } : {}),
  };
}

function applyToolCall(state: ExecutionTreeState, env: Envelope, payload: Record<string, unknown>): void {
  const callId = asString(env.call_id);
  if (!callId) return;

  // tool_call is an idempotent lifecycle start keyed by call_id. Approval resume,
  // reconnect replay, or at-least-once delivery may publish the same start more
  // than once. Reuse the object already attached to the round so a later
  // tool_result updates the object rendered by consumers, and never regresses a
  // terminal tool back to running.
  const existing = state.toolsByCallId.get(callId);
  if (existing) {
    const toolName = asString(payload.tool);
    if (!existing.toolName && toolName) existing.toolName = toolName;
    if (existing.arguments === undefined && payload.input !== undefined) existing.arguments = payload.input;
    return;
  }

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
  const r = ensureRound(parent, asNumber(payload.round) ?? latestRound(parent));
  if (!r.toolCalls.some((t) => t.callId === callId)) r.toolCalls.push(tool);
}

function applyToolResult(state: ExecutionTreeState, env: Envelope, payload: Record<string, unknown>): void {
  const callId = asString(env.call_id);
  if (!callId) return;
  const tool = state.toolsByCallId.get(callId);
  if (!tool) return;
  const status = asString(payload.status);
  tool.status = payload.ok === true
    ? "succeeded"
    : status === "interrupted" ? "interrupted" : "failed";
  const observation = asString(payload.observation);
  if (observation) tool.observation = observation;
  const summary = asString(payload.summary);
  if (summary) tool.summary = summary;
  if (Array.isArray(payload.files)) {
    tool.files = payload.files.filter(isToolFileRef);
  }
  const elapsed = asNumber(payload.elapsed_ms);
  if (elapsed !== undefined) tool.elapsedMs = elapsed;
  const approval = asRecord(payload.approval);
  const approvalStatus = asString(approval.status);
  if (approvalStatus === "pending" || approvalStatus === "granted" || approvalStatus === "denied") {
    tool.approval = { status: approvalStatus };
  }
}

function isToolFileRef(value: unknown): value is NonNullable<ExecutionToolCall["files"]>[number] {
  const file = asRecord(value);
  const fileType = asString(file.file_type);
  return (fileType === "json" || fileType === "text" || fileType === "image")
    && typeof file.path === "string"
    && file.path.length > 0
    && typeof file.media_type === "string"
    && file.media_type.length > 0
    && typeof file.size === "number"
    && Number.isInteger(file.size)
    && file.size >= 0
    && isPlainRecord(file.metadata);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
        displayName: asString(payload.display_name),
        task: asString(payload.task),
        parentCallId: asString(lineage.parent_call_id),
        invocationCallId: asString(payload.invocation_call_id),
      });
      return;
    }
    case "agent_ended": {
      const callId = asString(env.call_id);
      if (!callId) return;
      const agent = state.agentsByCallId.get(callId);
      const status = asString(payload.status);
      // Keep the projection strict even when a caller bypasses the transport
      // schema. An incomplete terminal event must never be inferred as a
      // success or failure with different semantics.
      if (status !== "succeeded" && status !== "failed" && status !== "interrupted") return;
      if (typeof payload.success !== "boolean" || payload.success !== (status === "succeeded")) return;
      const nextStatus = status;
      const result = asString(payload.result);
      if (!agent) {
        const lineage = asRecord(payload.lineage);
        const parentCallId = asString(lineage.parent_call_id);
        if (parentCallId) ensureAgent(state, parentCallId, {});
        const terminalAgent = ensureAgent(state, callId, {
          agentId: asString(env.agent_id),
          ...(parentCallId ? { parentCallId } : {}),
        });
        terminalAgent.status = nextStatus;
        if (result) terminalAgent.result = result;
        return;
      }
      if (agent.status !== "running") return;
      agent.status = nextStatus;
      if (result) agent.result = result;
      return;
    }
    case "stream_output": {
      const phase = asString(payload.phase);
      if (phase === "intent_delta" || phase === "intent_complete") {
        applyIntentStream(state, env, payload);
      } else if (phase === "delta" || phase === "part_added" || phase === "final") {
        applyOutputStream(state, env, payload);
      }
      return;
    }
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
