import { describe, expect, it } from "vitest";

import { ProtocolEnvelopeSchema } from "../src/protocol.js";

describe("ProtocolEnvelope participant_id", () => {
  it("接受可选 participant_id（子 run 归属，前端直路由参与者线程）", () => {
    const parsed = ProtocolEnvelopeSchema.parse({
      type: "stream_output",
      session_id: "s-1",
      run_id: "child-run-1",
      participant_id: "child-1",
      payload: { phase: "final", content: "子智能体最终答案" },
    });
    expect(parsed.participant_id).toBe("child-1");
  });

  it("缺失 participant_id 仍合法（缺失即根身份），空串被拒", () => {
    const rootFrame = ProtocolEnvelopeSchema.safeParse({
      type: "stream_output",
      session_id: "s-1",
      run_id: "run-1",
      payload: { phase: "delta", content: "hi" },
    });
    expect(rootFrame.success).toBe(true);

    const emptyId = ProtocolEnvelopeSchema.safeParse({
      type: "stream_output",
      session_id: "s-1",
      participant_id: "",
    });
    expect(emptyId.success).toBe(false);
  });
});
