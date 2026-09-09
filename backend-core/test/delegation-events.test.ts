import { describe, expect, it } from "vitest";

import { buildAgentCallStart } from "../src/services/agent/delegation/events.js";

describe("buildAgentCallStart 子 run 锚点帧", () => {
  it("顶层盖 participant_id（参与者线程直路由），payload 保留 child_agent_id 与 lineage", () => {
    const envelope = buildAgentCallStart({
      sessionId: "s-1",
      parentRunId: "run-root-1",
      parentAgentName: "main",
      parentCallId: "call-tool-1",
      rootParentCallId: "call-root-1",
      agentCallId: "call-child-1",
      agentName: "worker",
      childDisplayName: "工作者",
      description: "检查代码",
      childAgentId: "child-1",
      mode: "create",
      runId: "run-child-1",
    });

    expect(envelope.type).toBe("agent_started");
    // agent_started 是子条目诞生的锚点帧：participant_id 必须顶层直达，
    // 前端路由不得依赖 payload.child_agent_id 兜底（契约与其余子 run 信封一致）。
    expect(envelope.participant_id).toBe("child-1");
    expect(envelope.payload).toMatchObject({
      phase: "start",
      child_agent_id: "child-1",
      lineage: { parent_call_id: "call-root-1" },
    });
  });
});
