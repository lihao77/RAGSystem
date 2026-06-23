/**
 * 执行树投影骨架（新写，非搬运前端 executionProjector.js）。
 *
 * 消费新 envelope：tool_call（工具开始 / 委托请求）+ tool_result（工具结束 / 委托回传），
 * 按 call_id 配对、按 payload.lineage.parent_call_id 关联父子，构建只读执行树。
 *
 * 本期为骨架：仅实现调用配对与父子关联。
 * 旧算法中依赖已砍字段（round / order / step_id）的「轮次分组 / call_agent 委派合并 /
 * pending 队列 / root attach」机制暂不实现，待后端切新协议后扩展。
 */
import type { Envelope } from "./protocol.js";
import type { ExecutionTree, ToolCallNode } from "./agent-sdk.js";

export interface ExecutionTreeState {
  roots: ToolCallNode[];
  byCallId: Map<string, ToolCallNode>;
  raw: Envelope[];
}

export function createExecutionTreeState(): ExecutionTreeState {
  return { roots: [], byCallId: new Map(), raw: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildNode(env: Envelope): ToolCallNode {
  const payload = asRecord(env.payload);
  const lineage = asRecord(payload.lineage);
  const node: ToolCallNode = {
    callId: asString(env.call_id) ?? "",
    toolName: asString(payload.tool) ?? "",
    status: "running",
    children: [],
  };
  const parentCallId = asString(lineage.parent_call_id);
  if (parentCallId) node.parentCallId = parentCallId;
  if ("input" in payload) node.arguments = payload.input;
  return node;
}

function attachNode(state: ExecutionTreeState, node: ToolCallNode): void {
  const parent = node.parentCallId ? state.byCallId.get(node.parentCallId) : undefined;
  if (parent && !parent.children.some((c) => c.callId === node.callId)) {
    parent.children.push(node);
  } else {
    state.roots.push(node);
  }
  state.byCallId.set(node.callId, node);
}

/** 将一条 envelope 投影进状态机（仅处理 tool_call / tool_result）。 */
export function applyEnvelope(state: ExecutionTreeState, env: Envelope): void {
  state.raw.push(env);
  if (env.type !== "tool_call" && env.type !== "tool_result") return;

  const callId = asString(env.call_id);
  if (!callId) return;
  const payload = asRecord(env.payload);

  if (env.type === "tool_call") {
    if (!state.byCallId.has(callId)) {
      attachNode(state, buildNode(env));
    }
    return;
  }

  // tool_result：按 call_id 收敛节点终态
  const node = state.byCallId.get(callId);
  if (!node) return;
  node.status = payload.ok === true ? "succeeded" : "failed";
  const observation = asString(payload.observation);
  if (observation) node.summary = observation;
  const summary = asString(payload.summary);
  if (summary) node.summary = summary;
  if (typeof payload.elapsed_ms === "number") node.elapsedMs = payload.elapsed_ms;
  const approval = asRecord(payload.approval);
  const approvalStatus = asString(approval.status);
  if (approvalStatus === "pending" || approvalStatus === "granted" || approvalStatus === "denied") {
    node.approval = { status: approvalStatus };
  }
}

/** 顶层便利：从一串 envelope 构建完整执行树。 */
export function buildExecutionTree(envs: Iterable<Envelope>): ExecutionTree {
  const state = createExecutionTreeState();
  for (const env of envs) applyEnvelope(state, env);
  return { roots: state.roots, steps: state.raw };
}
