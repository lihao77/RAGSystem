import { describe, expect, it } from "vitest";
import {
  applyEnvelope,
  buildExecutionTree,
  createExecutionTreeState,
  getExecutionTree,
  translateKernelEvent,
  type Envelope,
  type KernelWireEvent,
  type WireTranslationContext,
} from "@ragsystem/agent-protocol";

// 回归：子 agent 的工具调用必须挂到根 agent 的子 agent 容器下（前端才能看见）。
// 根因是 root run 的 call_agent 工具 ctx.parentCallId 为 null（runtime.ts 曾用 input.parentCallId ?? null，
// 而 backend baseExecCtx 用 input.parentCallId ?? input.rootCallId），导致 delegation 发的 agent_started
// 没有 lineage.parent_call_id，子 agent 沦为脱离的第二个 root，其工具永远渲染不出来。
// 本测试模拟整条 envelope 序列（root call_agent → child agent_started → child tool_call），
// 断言执行树把子 agent 挂到 root 下、子 agent 的工具挂到子 agent 下。
describe("child-agent tool visibility in execution-tree projection", () => {
  const ROOT_CALL = "call_root";
  const ROOT_TOOL_CALL = "call_root_tool_1";
  const AGENT_CALL = "call_agent_1"; // delegation 为本次 call_agent 生成的 agent call id
  const CHILD_TOOL_CALL = "call_child_tool_1";

  // root run 的 call_agent 工具：lineage.parent_call_id 必须是 ROOT_CALL（runtime.ts 修复后由
  // toolContext.parentCallId ?? rootCallId 保证）。修复前此处传 null，投影把工具挂到隐式 root。
  const rootCtx: WireTranslationContext = {
    sessionId: "s1",
    runId: "root-run",
    rootCallId: ROOT_CALL,
    requestId: "r1",
    agentId: "orchestrator",
    agentDisplayName: "编排者",
  };

  // child run：rootCallId = AGENT_CALL（delegation 传入），与 agent_started 的 call_id 对齐。
  const childCtx: WireTranslationContext = {
    sessionId: "s1",
    runId: "child-run",
    rootCallId: AGENT_CALL,
    requestId: "r1",
    agentId: "worker",
    agentDisplayName: "执行者",
    parentCallId: ROOT_CALL,
  };

  const envs: Envelope[] = [];
  const feed = (ctx: WireTranslationContext, ev: KernelWireEvent): void => {
    for (const e of translateKernelEvent(ev, ctx)) envs.push(e);
  };

  it("nests child agent and its tools under root when lineage is correct", () => {
    // root agent started（delegation-style：无 parent，root）
    envs.push({
      type: "agent_started",
      session_id: "s1",
      run_id: "root-run",
      call_id: ROOT_CALL,
      agent_id: "orchestrator",
      payload: { phase: "start", task: "do work", display_name: "编排者" },
    });
    // root 调用 call_agent 工具：lineage.parent_call_id = ROOT_CALL（修复后的契约）
    feed(rootCtx, {
      type: "tool_call",
      agentName: "orchestrator",
      round: 0,
      order: 1,
      roundIndex: 1,
      toolCallId: ROOT_TOOL_CALL,
      toolName: "call_agent",
      arguments: { agent_name: "worker", task: "subtask" },
    });
    // delegation 发 child agent_started：lineage.parent_call_id = ROOT_CALL（修复后 rootParentCallId 解析正确）
    envs.push({
      type: "agent_started",
      session_id: "s1",
      run_id: "root-run",
      call_id: AGENT_CALL,
      agent_id: "worker",
      payload: {
        phase: "start",
        task: "subtask",
        display_name: "执行者",
        invocation_call_id: ROOT_TOOL_CALL,
        lineage: { parent_call_id: ROOT_CALL },
      },
    });
    // child agent 的工具调用：translateKernelEvent 用 childCtx，lineage.parent_call_id = AGENT_CALL
    feed(childCtx, {
      type: "tool_call",
      agentName: "worker",
      round: 0,
      order: 1,
      roundIndex: 1,
      toolCallId: CHILD_TOOL_CALL,
      toolName: "read_file",
      arguments: { path: "a.txt" },
    });

    const tree = buildExecutionTree(envs);
    expect(tree.root).toMatchObject({ callId: ROOT_CALL, agentId: "orchestrator" });

    // 子 agent 挂在 root 下（而非沦为第二个 root）
    expect(tree.root?.children).toHaveLength(1);
    const child = tree.root?.children[0];
    expect(child).toMatchObject({
      callId: AGENT_CALL,
      agentId: "worker",
      parentCallId: ROOT_CALL,
      invocationCallId: ROOT_TOOL_CALL,
    });

    // 子 agent 的工具挂在子 agent 的轮次下（这是"前端看得见"的判定）
    const childTools = child?.rounds.flatMap((r) => r.toolCalls) ?? [];
    expect(childTools.map((t) => t.callId)).toContain(CHILD_TOOL_CALL);
  });

  it("preserves child lineage on streamed output", () => {
    const [event] = translateKernelEvent(
      { type: "output_delta", agentName: "worker", content: "child output" },
      childCtx,
    );

    expect(event).toMatchObject({
      type: "stream_output",
      run_id: "child-run",
      call_id: AGENT_CALL,
      payload: {
        phase: "delta",
        content: "child output",
        lineage: { parent_call_id: ROOT_CALL },
      },
    });
  });

  it("does NOT nest child under root when lineage is broken (regression guard)", () => {
    // 同样序列，但 agent_started 缺 lineage（复现修复前的 rootParentCallId=null）。
    // 此时子 agent 沦为第二个 root，其工具不在 root 树里——证明 lineage 是可见性的决定因素。
    const broken: Envelope[] = [];
    const state = createExecutionTreeState();
    broken.push({
      type: "agent_started",
      session_id: "s1",
      run_id: "root-run",
      call_id: ROOT_CALL,
      agent_id: "orchestrator",
      payload: { phase: "start", task: "do work", display_name: "编排者" },
    });
    broken.push({
      type: "agent_started",
      session_id: "s1",
      run_id: "root-run",
      call_id: AGENT_CALL,
      agent_id: "worker",
      payload: { phase: "start", task: "subtask", display_name: "执行者" }, // 无 lineage
    });
    broken.push(...translateKernelEvent(
      { type: "tool_call", agentName: "worker", round: 0, order: 1, roundIndex: 1, toolCallId: CHILD_TOOL_CALL, toolName: "read_file", arguments: {} },
      childCtx,
    ));
    for (const e of broken) applyEnvelope(state, e);
    const brokenTree = getExecutionTree(state);

    expect(brokenTree.root?.children ?? []).toEqual([]);
  });
});
